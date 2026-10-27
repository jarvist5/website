import express from "express";
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
  scrypt,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const IDLE_LIFETIME = 15 * MINUTE;
const ABSOLUTE_LIFETIME = 8 * 60 * MINUTE;
const SETUP_LIFETIME = 10 * MINUTE;
const SCRYPT = Object.freeze({
  N: 65536,
  r: 8,
  p: 2,
  maxmem: 96 * 1024 * 1024,
});
const HASH_BYTES = 64;
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const digest = (value) => createHash("sha256").update(value).digest("hex");
const constantEqual = (left, right) => {
  if (typeof left !== "string" || typeof right !== "string") return false;
  return timingSafeEqual(
    createHash("sha256").update(left).digest(),
    createHash("sha256").update(right).digest(),
  );
};

class BusyError extends Error {}
class AuthRequestError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
let deriving = false;
const deriveQueue = [];
async function derivePassword(password, salt) {
  if (deriving) {
    if (deriveQueue.length >= 4)
      throw new BusyError("Owner authentication is busy.");
    await new Promise((resolve) => deriveQueue.push(resolve));
  } else deriving = true;
  try {
    return await new Promise((resolve, reject) =>
      scrypt(password, salt, HASH_BYTES, SCRYPT, (error, result) =>
        error ? reject(error) : resolve(result),
      ),
    );
  } finally {
    const next = deriveQueue.shift();
    if (next) next();
    else deriving = false;
  }
}

export async function hashOwnerPassword(password) {
  const salt = randomBytes(16);
  const hash = await derivePassword(password, salt);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}
export async function verifyOwnerPassword(password, stored) {
  if (
    typeof password !== "string" ||
    password.length > 128 ||
    Buffer.byteLength(password) > 512 ||
    typeof stored !== "string"
  )
    return false;
  const parts = stored.split("$");
  if (
    parts.length !== 6 ||
    parts[0] !== "scrypt" ||
    Number(parts[1]) !== SCRYPT.N ||
    Number(parts[2]) !== SCRYPT.r ||
    Number(parts[3]) !== SCRYPT.p
  )
    return false;
  const salt = Buffer.from(parts[4], "base64url"),
    expected = Buffer.from(parts[5], "base64url");
  if (salt.length !== 16 || expected.length !== HASH_BYTES) return false;
  const actual = await derivePassword(password, salt);
  return timingSafeEqual(actual, expected);
}
let dummyPasswordHash;
const dummyHash = () =>
  (dummyPasswordHash ??= hashOwnerPassword(
    randomBytes(32).toString("base64url"),
  ).catch((error) => {
    dummyPasswordHash = undefined;
    throw error;
  }));

function base32Encode(bytes) {
  let accumulator = 0,
    bits = 0,
    result = "";
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      result += BASE32[(accumulator >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits) result += BASE32[(accumulator << (5 - bits)) & 31];
  return result;
}
function base32Decode(text) {
  let accumulator = 0,
    bits = 0;
  const bytes = [];
  for (const letter of text.replace(/=+$/, "").toUpperCase()) {
    const value = BASE32.indexOf(letter);
    if (value < 0) throw new Error("Invalid authenticator secret");
    accumulator = (accumulator << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bytes.push((accumulator >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}
export function ownerTotp(secret, timestamp = Date.now(), digits = 6) {
  if (!Number.isFinite(timestamp) || timestamp < 0 || ![6, 8].includes(digits))
    throw new Error("Invalid authenticator parameters");
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(timestamp / 30000)));
  const value = createHmac("sha1", base32Decode(secret))
    .update(counter)
    .digest();
  const offset = value[value.length - 1] & 15;
  return String(
    (value.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits,
  ).padStart(digits, "0");
}
function matchTotp(secret, code, timestamp, lastCounter = -1) {
  if (typeof code !== "string" || code.length > 32) return null;
  code = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(code)) return null;
  const current = Math.floor(timestamp / 30000);
  let matched = null;
  for (let drift = -1; drift <= 1; drift++) {
    const counter = current + drift;
    if (
      counter >= 0 &&
      counter > lastCounter &&
      constantEqual(ownerTotp(secret, counter * 30000), code)
    )
      matched = counter;
  }
  return matched;
}
const validPassword = (value) =>
  typeof value === "string" &&
  value.length >= 14 &&
  value.length <= 128 &&
  Buffer.byteLength(value) <= 512;
const normalizeUsername = (value) =>
  typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{2,39}$/.test(value)
    ? value.toLowerCase()
    : null;
const tokenValue = (value) =>
  typeof value === "string" && value.length >= 32 && value.length <= 256
    ? value
    : null;
const recoveryHash = (value) => {
  if (typeof value !== "string" || value.length > 64) return null;
  const normalized = value.replace(/-/g, "").trim().toLowerCase();
  return /^[a-f0-9]{32}$/.test(normalized) ? digest(normalized) : null;
};
const recoveryCode = () =>
  randomBytes(16)
    .toString("hex")
    .match(/.{1,8}/g)
    .join("-");

/** Single-owner authentication. All long-lived secrets come from secure environment configuration. */
export function createOwnerAuth({
  db,
  setupToken = "",
  setupExpires = "",
  production = false,
  origin = "",
  sessionKey = "",
  now = () => Date.now(),
} = {}) {
  if (!db?.prepare)
    throw new Error("Owner authentication requires a database.");
  let configuredOrigin = null;
  try {
    const url = new URL(origin);
    if (
      !url.username &&
      !url.password &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash &&
      ["http:", "https:"].includes(url.protocol)
    )
      configuredOrigin = url.origin;
  } catch {
    /* local requests may supply their actual origin */
  }
  const keyAvailable =
    typeof sessionKey === "string" && sessionKey.length >= 32;
  const ready =
    keyAvailable && (!production || configuredOrigin?.startsWith("https://"));
  const encryptionKey = keyAvailable
    ? createHash("sha256").update(sessionKey).digest()
    : null;
  const bootstrapExpiry =
    typeof setupExpires === "number" ? setupExpires : Date.parse(setupExpires);
  const cookieName = production ? "__Host-leafivo_owner" : "leafivo_owner";
  const router = express.Router();
  db.exec(`
    CREATE TABLE IF NOT EXISTS owner_identity (
      id INTEGER PRIMARY KEY CHECK(id=1), username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL, totp_secret TEXT NOT NULL,
      last_counter INTEGER NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS owner_setup_pending (
      token_hash TEXT PRIMARY KEY, username TEXT NOT NULL, password_hash TEXT NOT NULL,
      totp_secret TEXT NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS owner_sessions (
      token_hash TEXT PRIMARY KEY, owner_id INTEGER NOT NULL,
      csrf_token TEXT NOT NULL, created_at INTEGER NOT NULL,
      last_seen INTEGER NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS owner_mfa_pending (
      token_hash TEXT PRIMARY KEY, session_hash TEXT NOT NULL, password_hash TEXT NOT NULL,
      totp_secret TEXT NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS owner_recovery (
      token_hash TEXT PRIMARY KEY, owner_id INTEGER NOT NULL, created_at INTEGER NOT NULL
    );
  `);
  const owner = () =>
    db.prepare("SELECT * FROM owner_identity WHERE id=1").get();
  const setupAvailable = () =>
    ready &&
    !owner() &&
    typeof setupToken === "string" &&
    setupToken.length >= 32 &&
    Number.isFinite(bootstrapExpiry) &&
    bootstrapExpiry > now();
  const status = () => ({
    configured: Boolean(owner()),
    setupAvailable: setupAvailable(),
    available: Boolean(ready),
  });
  const encrypt = (value, purpose) => {
    const nonce = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", encryptionKey, nonce);
    cipher.setAAD(Buffer.from(purpose));
    const encrypted = Buffer.concat([
      cipher.update(value, "utf8"),
      cipher.final(),
    ]);
    return [nonce, cipher.getAuthTag(), encrypted]
      .map((v) => v.toString("base64url"))
      .join(".");
  };
  const decrypt = (value, purpose) => {
    const parts = value.split(".").map((v) => Buffer.from(v, "base64url"));
    if (parts.length !== 3 || parts[0].length !== 12 || parts[1].length !== 16)
      throw new Error("Invalid owner secret");
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey, parts[0]);
    decipher.setAAD(Buffer.from(purpose));
    decipher.setAuthTag(parts[1]);
    return Buffer.concat([
      decipher.update(parts[2]),
      decipher.final(),
    ]).toString("utf8");
  };
  const clearCookie = (res) =>
    res.clearCookie(cookieName, {
      httpOnly: true,
      secure: production,
      sameSite: "strict",
      path: "/",
    });
  const setCookie = (res, token) =>
    res.cookie(cookieName, token, {
      httpOnly: true,
      secure: production,
      sameSite: "strict",
      path: "/",
      maxAge: ABSOLUTE_LIFETIME,
    });
  const expectedOrigin = (req) =>
    configuredOrigin ??
    (!production ? `${req.protocol}://${req.get("host")}` : null);
  const originAllowed = (req) =>
    Boolean(expectedOrigin(req)) &&
    req.get("Origin") === expectedOrigin(req) &&
    req.get("Sec-Fetch-Site") !== "cross-site";
  const noStore = (req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  };
  router.use(noStore);
  router.use((req, res, next) => {
    if (!ready && !(req.method === "GET" && req.path === "/session"))
      return res
        .status(503)
        .json({
          error: "Secure owner access is not configured.",
          code: "OWNER_UNAVAILABLE",
        });
    if (
      ["POST", "PUT", "PATCH", "DELETE"].includes(req.method) &&
      !originAllowed(req)
    )
      return res
        .status(403)
        .json({
          error: "Request origin is not permitted.",
          code: "ORIGIN_REQUIRED",
        });
    next();
  });
  const buckets = new Map();
  const takeBudget = (key, limit, res) => {
    const timestamp = now();
    if (buckets.size >= 1024)
      for (const [key, value] of buckets)
        if (value.until <= timestamp) buckets.delete(key);
    if (!buckets.has(key) && buckets.size >= 2048) {
      res
        .set("Retry-After", "60")
        .status(503)
        .json({
          error: "Owner access is busy. Try again shortly.",
          code: "OWNER_BUSY",
        });
      return false;
    }
    const previous = buckets.get(key);
    const record =
      previous && previous.until > timestamp
        ? previous
        : { count: 0, until: timestamp + 15 * MINUTE };
    buckets.set(key, record);
    if (++record.count > limit) {
      res
        .set(
          "Retry-After",
          String(Math.max(1, Math.ceil((record.until - timestamp) / 1000))),
        )
        .status(429)
        .json({
          error: "Too many owner access attempts. Try again later.",
          code: "OWNER_RATE_LIMIT",
        });
      return false;
    }
    return true;
  };
  const budget =
    (scope, limit = 5) =>
    (req, res, next) => {
      const username = normalizeUsername(req.body?.username) ?? "invalid";
      if (!takeBudget(`${scope}:ip:${req.ip}`, limit, res)) return;
      if (
        scope === "login" &&
        !takeBudget(`${scope}:user:${username}`, limit, res)
      )
        return;
      next();
    };
  const invalidateExpired = () => {
    const timestamp = now();
    db.prepare("DELETE FROM owner_setup_pending WHERE expires_at<=?").run(
      timestamp,
    );
    db.prepare("DELETE FROM owner_mfa_pending WHERE expires_at<=?").run(
      timestamp,
    );
    db.prepare(
      "DELETE FROM owner_sessions WHERE expires_at<=? OR last_seen<=?",
    ).run(timestamp, timestamp - IDLE_LIFETIME);
  };
  const readSession = (req, res, touch = true) => {
    if (!ready) return null;
    const parts = (req.headers.cookie ?? "")
      .split(";")
      .map((v) => v.trim())
      .filter((v) => v.startsWith(cookieName + "="));
    if (parts.length !== 1) return null;
    const raw = parts[0].slice(cookieName.length + 1);
    if (!/^[A-Za-z0-9_-]{43}$/.test(raw)) {
      clearCookie(res);
      return null;
    }
    const hash = digest(raw),
      row = db
        .prepare("SELECT * FROM owner_sessions WHERE token_hash=?")
        .get(hash),
      timestamp = now();
    if (
      !row ||
      row.owner_id !== 1 ||
      row.created_at > timestamp ||
      row.last_seen > timestamp ||
      row.expires_at <= timestamp ||
      row.last_seen + IDLE_LIFETIME <= timestamp
    ) {
      if (row)
        db.prepare("DELETE FROM owner_sessions WHERE token_hash=?").run(hash);
      clearCookie(res);
      return null;
    }
    const identity = owner();
    if (!identity) {
      clearCookie(res);
      return null;
    }
    let csrf;
    try {
      csrf = decrypt(row.csrf_token, `session:${hash}`);
    } catch {
      db.prepare("DELETE FROM owner_sessions WHERE token_hash=?").run(hash);
      clearCookie(res);
      return null;
    }
    if (touch)
      db.prepare(
        "UPDATE owner_sessions SET last_seen=? WHERE token_hash=?",
      ).run(timestamp, hash);
    return { hash, csrf, owner: { username: identity.username }, identity };
  };
  const createSession = (res) => {
    invalidateExpired();
    const raw = randomBytes(32).toString("base64url"),
      hash = digest(raw),
      csrf = randomBytes(32).toString("base64url"),
      timestamp = now();
    db.prepare(
      "INSERT INTO owner_sessions(token_hash,owner_id,csrf_token,created_at,last_seen,expires_at) VALUES (?,1,?,?,?,?)",
    ).run(
      hash,
      encrypt(csrf, `session:${hash}`),
      timestamp,
      timestamp,
      timestamp + ABSOLUTE_LIFETIME,
    );
    setCookie(res, raw);
    return { owner: { username: owner().username }, csrfToken: csrf };
  };
  const requireOwner = (req, res, next) => {
    res.set("Cache-Control", "no-store");
    const session = readSession(req, res);
    if (!session)
      return res
        .status(401)
        .json({
          error: "Owner sign-in is required.",
          code: "OWNER_SIGN_IN_REQUIRED",
        });
    if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
      if (!originAllowed(req))
        return res
          .status(403)
          .json({
            error: "Request origin is not permitted.",
            code: "ORIGIN_REQUIRED",
          });
      if (!constantEqual(req.get("X-CSRF-Token"), session.csrf))
        return res
          .status(403)
          .json({
            error: "Refresh the owner page and try again.",
            code: "CSRF_REQUIRED",
          });
    }
    req.owner = session.owner;
    req.ownerSession = { hash: session.hash, csrfToken: session.csrf };
    next();
  };
  // Status remains readable when credentials have not yet been provisioned.
  router.get("/session", (req, res) => {
    const session = readSession(req, res);
    res.json({
      ...status(),
      authenticated: Boolean(session),
      ...(session
        ? {
            owner: session.owner,
            csrfToken: session.csrf,
            recoveryCodesRemaining: Number(
              db.prepare("SELECT count(*) AS count FROM owner_recovery").get()
                .count,
            ),
          }
        : {}),
    });
  });
  router.post("/setup/start", budget("setup"), async (req, res, next) => {
    try {
      const username = normalizeUsername(req.body?.username),
        password = req.body?.password;
      if (!setupAvailable() || !constantEqual(req.body?.setupToken, setupToken))
        return res
          .status(403)
          .json({
            error: "This owner activation link is unavailable or expired.",
            code: "SETUP_UNAVAILABLE",
          });
      if (!username || !validPassword(password))
        return res
          .status(400)
          .json({
            error:
              "Choose a username of 3–40 letters, numbers, dots, hyphens or underscores, and a password of 14–128 characters.",
            code: "INVALID_OWNER_DETAILS",
          });
      const hash = await hashOwnerPassword(password);
      if (!setupAvailable())
        return res
          .status(403)
          .json({
            error: "This owner activation link is unavailable or expired.",
            code: "SETUP_UNAVAILABLE",
          });
      const raw = randomBytes(32).toString("base64url"),
        flowHash = digest(raw),
        secret = base32Encode(randomBytes(20));
      db.exec("BEGIN IMMEDIATE");
      try {
        if (owner())
          throw new AuthRequestError(
            403,
            "Owner setup is no longer available.",
            "SETUP_UNAVAILABLE",
          );
        db.prepare("DELETE FROM owner_setup_pending").run();
        db.prepare(
          "INSERT INTO owner_setup_pending(token_hash,username,password_hash,totp_secret,expires_at) VALUES (?,?,?,?,?)",
        ).run(
          flowHash,
          username,
          hash,
          encrypt(secret, `pending:${flowHash}`),
          Math.min(now() + SETUP_LIFETIME, bootstrapExpiry),
        );
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      res
        .status(201)
        .json({
          flowToken: raw,
          secret,
          otpauthUrl: `otpauth://totp/${encodeURIComponent(`Leafivo:${username}`)}?secret=${secret}&issuer=Leafivo&algorithm=SHA1&digits=6&period=30`,
          expiresIn: 600,
        });
    } catch (error) {
      next(error);
    }
  });
  router.post(
    "/setup/complete",
    budget("setup-complete"),
    async (req, res, next) => {
      try {
        const flow = tokenValue(req.body?.flowToken),
          hash = flow && digest(flow),
          pending =
            hash &&
            db
              .prepare("SELECT * FROM owner_setup_pending WHERE token_hash=?")
              .get(hash);
        if (!setupAvailable() || !pending || pending.expires_at <= now())
          return res
            .status(403)
            .json({
              error:
                "This owner setup has expired. Open a valid activation link again.",
              code: "SETUP_UNAVAILABLE",
            });
        const secret = decrypt(pending.totp_secret, `pending:${hash}`),
          counter = matchTotp(secret, req.body?.code, now());
        if (counter === null)
          return res
            .status(401)
            .json({
              error: "Enter a current six-digit authenticator code.",
              code: "INVALID_AUTHENTICATOR_CODE",
            });
        const recoveryCodes = Array.from({ length: 10 }, recoveryCode);
        let sessionPayload;
        db.exec("BEGIN IMMEDIATE");
        try {
          const current = db
            .prepare("SELECT * FROM owner_setup_pending WHERE token_hash=?")
            .get(hash);
          if (
            owner() ||
            !current ||
            current.expires_at <= now() ||
            !setupAvailable()
          )
            throw new AuthRequestError(
              403,
              "Owner setup is no longer available.",
              "SETUP_UNAVAILABLE",
            );
          db.prepare(
            "INSERT INTO owner_identity(id,username,password_hash,totp_secret,last_counter,created_at) VALUES (1,?,?,?,?,?)",
          ).run(
            pending.username,
            pending.password_hash,
            encrypt(secret, "owner:1"),
            counter,
            now(),
          );
          const insert = db.prepare(
            "INSERT INTO owner_recovery(token_hash,owner_id,created_at) VALUES (?,1,?)",
          );
          for (const code of recoveryCodes)
            insert.run(recoveryHash(code), now());
          db.prepare("DELETE FROM owner_setup_pending").run();
          db.prepare("DELETE FROM owner_sessions").run();
          sessionPayload = createSession(res);
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
        res.status(201).json({ ...sessionPayload, recoveryCodes });
      } catch (error) {
        next(error);
      }
    },
  );
  router.post("/login", budget("login"), async (req, res, next) => {
    try {
      const username = normalizeUsername(req.body?.username),
        identity = owner();
      const stored =
        identity && username === identity.username
          ? identity.password_hash
          : await dummyHash();
      const valid = await verifyOwnerPassword(req.body?.password, stored);
      const reject = () =>
        res
          .status(401)
          .json({
            error:
              "The sign-in details or authenticator code were not accepted.",
            code: "INVALID_LOGIN",
          });
      if (!valid || !identity || identity.username !== username)
        return reject();
      // Password verification is asynchronous: reload the identity before accepting MFA.
      const current = owner();
      if (!current || current.password_hash !== identity.password_hash)
        return reject();
      const recovery = recoveryHash(req.body?.recoveryCode);
      const counter =
        req.body?.recoveryCode === undefined
          ? matchTotp(
              decrypt(current.totp_secret, "owner:1"),
              req.body?.code,
              now(),
              current.last_counter,
            )
          : null;
      if (req.body?.recoveryCode !== undefined ? !recovery : counter === null)
        return reject();
      let payload;
      db.exec("BEGIN IMMEDIATE");
      try {
        const latest = owner();
        if (!latest || latest.password_hash !== identity.password_hash)
          throw new AuthRequestError(
            401,
            "The sign-in details or authenticator code were not accepted.",
            "INVALID_LOGIN",
          );
        if (req.body?.recoveryCode !== undefined) {
          if (
            db
              .prepare(
                "DELETE FROM owner_recovery WHERE token_hash=? AND owner_id=1",
              )
              .run(recovery).changes !== 1
          )
            throw new AuthRequestError(
              401,
              "The sign-in details or authenticator code were not accepted.",
              "INVALID_LOGIN",
            );
        } else if (
          db
            .prepare(
              "UPDATE owner_identity SET last_counter=? WHERE id=1 AND last_counter<? AND password_hash=?",
            )
            .run(counter, counter, identity.password_hash).changes !== 1
        )
          throw new AuthRequestError(
            401,
            "The sign-in details or authenticator code were not accepted.",
            "INVALID_LOGIN",
          );
        const old = readSession(req, res, false);
        if (old)
          db.prepare("DELETE FROM owner_sessions WHERE token_hash=?").run(
            old.hash,
          );
        payload = createSession(res);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      res.json(payload);
    } catch (error) {
      next(error);
    }
  });
  router.post("/logout", requireOwner, (req, res) => {
    db.prepare("DELETE FROM owner_sessions WHERE token_hash=?").run(
      req.ownerSession.hash,
    );
    db.prepare("DELETE FROM owner_mfa_pending WHERE session_hash=?").run(
      req.ownerSession.hash,
    );
    clearCookie(res);
    res.json({ signedOut: true });
  });
  router.post(
    "/passwordchange",
    budget("passwordchange"),
    requireOwner,
    async (req, res, next) => {
      try {
        const identity = owner();
        if (!validPassword(req.body?.password))
          return res
            .status(400)
            .json({
              error: "Use a new password of 14–128 characters.",
              code: "INVALID_PASSWORD",
            });
        if (
          !(await verifyOwnerPassword(
            req.body?.currentPassword,
            identity.password_hash,
          ))
        )
          return res
            .status(401)
            .json({
              error:
                "The password or fresh authenticator code was not accepted.",
              code: "INVALID_LOGIN",
            });
        const passwordHash = await hashOwnerPassword(req.body.password),
          current = owner(),
          session = db
            .prepare("SELECT * FROM owner_sessions WHERE token_hash=?")
            .get(req.ownerSession.hash);
        if (
          !current ||
          current.password_hash !== identity.password_hash ||
          !session ||
          session.expires_at <= now() ||
          session.last_seen + IDLE_LIFETIME <= now()
        )
          return res
            .status(401)
            .json({
              error: "Sign in again before changing your password.",
              code: "OWNER_SIGN_IN_REQUIRED",
            });
        const counter = matchTotp(
          decrypt(current.totp_secret, "owner:1"),
          req.body?.code,
          now(),
          current.last_counter,
        );
        if (counter === null)
          return res
            .status(401)
            .json({
              error:
                "Enter a fresh authenticator code. Wait for the next code if you just signed in.",
              code: "INVALID_AUTHENTICATOR_CODE",
            });
        db.exec("BEGIN IMMEDIATE");
        try {
          const liveSession = db
            .prepare("SELECT * FROM owner_sessions WHERE token_hash=?")
            .get(req.ownerSession.hash);
          if (
            !liveSession ||
            liveSession.expires_at <= now() ||
            liveSession.last_seen + IDLE_LIFETIME <= now()
          )
            throw new AuthRequestError(
              401,
              "Sign in again before changing your password.",
              "OWNER_SIGN_IN_REQUIRED",
            );
          const changed = db
            .prepare(
              "UPDATE owner_identity SET password_hash=?,last_counter=? WHERE id=1 AND password_hash=? AND last_counter<?",
            )
            .run(passwordHash, counter, identity.password_hash, counter);
          if (changed.changes !== 1)
            throw new AuthRequestError(
              401,
              "Owner credentials changed. Sign in again.",
              "OWNER_SIGN_IN_REQUIRED",
            );
          db.prepare("DELETE FROM owner_sessions").run();
          db.prepare("DELETE FROM owner_mfa_pending").run();
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
        res.json({ ...createSession(res), passwordChanged: true });
      } catch (error) {
        next(error);
      }
    },
  );
  router.post(
    "/mfa/reset/start",
    budget("mfa-reset"),
    requireOwner,
    async (req, res, next) => {
      try {
        const identity = owner(),
          recovery = recoveryHash(req.body?.recoveryCode);
        if (
          !recovery ||
          !(await verifyOwnerPassword(
            req.body?.currentPassword,
            identity.password_hash,
          ))
        )
          return res
            .status(401)
            .json({
              error: "The password or recovery code was not accepted.",
              code: "INVALID_RECOVERY",
            });
        const raw = randomBytes(32).toString("base64url"),
          hash = digest(raw),
          secret = base32Encode(randomBytes(20));
        db.exec("BEGIN IMMEDIATE");
        try {
          const current = owner(),
            session = db
              .prepare("SELECT * FROM owner_sessions WHERE token_hash=?")
              .get(req.ownerSession.hash);
          if (
            !current ||
            current.password_hash !== identity.password_hash ||
            !session ||
            session.expires_at <= now() ||
            session.last_seen + IDLE_LIFETIME <= now()
          )
            throw new AuthRequestError(
              401,
              "Sign in again before replacing your authenticator.",
              "OWNER_SIGN_IN_REQUIRED",
            );
          if (
            db
              .prepare(
                "DELETE FROM owner_recovery WHERE token_hash=? AND owner_id=1",
              )
              .run(recovery).changes !== 1
          )
            throw new AuthRequestError(
              401,
              "The password or recovery code was not accepted.",
              "INVALID_RECOVERY",
            );
          db.prepare("DELETE FROM owner_mfa_pending").run();
          db.prepare(
            "INSERT INTO owner_mfa_pending(token_hash,session_hash,password_hash,totp_secret,expires_at) VALUES (?,?,?,?,?)",
          ).run(
            hash,
            req.ownerSession.hash,
            identity.password_hash,
            encrypt(secret, `mfa-reset:${hash}`),
            now() + SETUP_LIFETIME,
          );
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
        res
          .status(201)
          .json({
            flowToken: raw,
            secret,
            otpauthUrl: `otpauth://totp/${encodeURIComponent(`Leafivo:${identity.username}`)}?secret=${secret}&issuer=Leafivo&algorithm=SHA1&digits=6&period=30`,
            expiresIn: 600,
          });
      } catch (error) {
        next(error);
      }
    },
  );
  router.post(
    "/mfa/reset/complete",
    budget("mfa-complete"),
    requireOwner,
    (req, res, next) => {
      try {
        const raw = tokenValue(req.body?.flowToken),
          hash = raw && digest(raw),
          pending =
            hash &&
            db
              .prepare(
                "SELECT * FROM owner_mfa_pending WHERE token_hash=? AND session_hash=?",
              )
              .get(hash, req.ownerSession.hash);
        if (!pending || pending.expires_at <= now())
          return res
            .status(403)
            .json({
              error:
                "This authenticator enrollment has expired. Begin again with an unused recovery code.",
              code: "RECOVERY_EXPIRED",
            });
        const identity = owner();
        if (!identity || identity.password_hash !== pending.password_hash)
          return res
            .status(403)
            .json({
              error: "Sign in and begin recovery again.",
              code: "RECOVERY_EXPIRED",
            });
        const secret = decrypt(pending.totp_secret, `mfa-reset:${hash}`),
          counter = matchTotp(secret, req.body?.code, now());
        if (counter === null)
          return res
            .status(401)
            .json({
              error: "Enter a current code from your new authenticator.",
              code: "INVALID_AUTHENTICATOR_CODE",
            });
        const recoveryCodes = Array.from({ length: 10 }, recoveryCode);
        let payload;
        db.exec("BEGIN IMMEDIATE");
        try {
          const current = db
              .prepare(
                "SELECT * FROM owner_mfa_pending WHERE token_hash=? AND session_hash=?",
              )
              .get(hash, req.ownerSession.hash),
            session = db
              .prepare("SELECT * FROM owner_sessions WHERE token_hash=?")
              .get(req.ownerSession.hash);
          if (
            !current ||
            current.expires_at <= now() ||
            !session ||
            session.expires_at <= now() ||
            session.last_seen + IDLE_LIFETIME <= now()
          )
            throw new AuthRequestError(
              403,
              "Begin authenticator recovery again.",
              "RECOVERY_EXPIRED",
            );
          if (
            db
              .prepare(
                "UPDATE owner_identity SET totp_secret=?,last_counter=? WHERE id=1 AND password_hash=?",
              )
              .run(encrypt(secret, "owner:1"), counter, pending.password_hash)
              .changes !== 1
          )
            throw new AuthRequestError(
              403,
              "Begin authenticator recovery again.",
              "RECOVERY_EXPIRED",
            );
          db.prepare("DELETE FROM owner_sessions").run();
          db.prepare("DELETE FROM owner_recovery").run();
          db.prepare("DELETE FROM owner_mfa_pending").run();
          const insert = db.prepare(
            "INSERT INTO owner_recovery(token_hash,owner_id,created_at) VALUES (?,1,?)",
          );
          for (const code of recoveryCodes)
            insert.run(recoveryHash(code), now());
          payload = createSession(res);
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
        res.json({ ...payload, recoveryCodes, authenticatorChanged: true });
      } catch (error) {
        next(error);
      }
    },
  );
  router.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error instanceof AuthRequestError)
      return res
        .status(error.status)
        .json({ error: error.message, code: error.code });
    if (error instanceof BusyError)
      return res
        .set("Retry-After", "5")
        .status(503)
        .json({
          error: "Owner authentication is busy. Try again shortly.",
          code: "OWNER_BUSY",
        });
    // Do not log passwords, authenticator secrets, setup links, session IDs or database rows.
    res
      .status(500)
      .json({
        error: "Owner access could not be completed. Please try again.",
        code: "OWNER_ACCESS_ERROR",
      });
  });
  return { router, middleware: { requireOwner }, status };
}
