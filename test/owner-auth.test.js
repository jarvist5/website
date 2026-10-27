import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { DatabaseSync } from "node:sqlite";
import {
  createOwnerAuth,
  ownerTotp,
  verifyOwnerPassword,
} from "../server/owner-auth.js";

const PASSWORD = "a private learning store passphrase";
const NEW_PASSWORD = "a different private store passphrase";
const SETUP = "test-only-bootstrap-never-use-in-production-123456";
const KEY = "test-only-stable-owner-encryption-key-1234567890";
const START = 1800000000000;
async function fixture(t, options = {}) {
  const db = new DatabaseSync(":memory:");
  let timestamp = START;
  const app = express();
  app.use(express.json({ limit: "24kb" }));
  const origin = options.production
    ? "https://owner.test"
    : "http://owner.test";
  const auth = createOwnerAuth({
    db,
    setupToken: SETUP,
    setupExpires: START + 60 * 60 * 1000,
    production: false,
    origin,
    sessionKey: KEY,
    now: () => timestamp,
    ...options,
  });
  app.use("/api/owner", auth.router);
  app.get("/protected", auth.middleware.requireOwner, (req, res) =>
    res.json({ owner: req.owner }),
  );
  app.post("/protected", auth.middleware.requireOwner, (req, res) =>
    res.json({ changed: true }),
  );
  const server = await new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  });
  let cookie = "";
  async function request(
    path,
    {
      method = "GET",
      data,
      headers = {},
      sendCookie = true,
      cookie: explicitCookie,
      origin: explicitOrigin,
    } = {},
  ) {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}${path}`,
      {
        method,
        headers: {
          ...(method !== "GET"
            ? { Origin: explicitOrigin === undefined ? origin : explicitOrigin }
            : {}),
          ...(data !== undefined ? { "Content-Type": "application/json" } : {}),
          ...((explicitCookie ?? (sendCookie ? cookie : ""))
            ? { Cookie: explicitCookie ?? cookie }
            : {}),
          ...headers,
        },
        ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
      },
    );
    const cookies = response.headers.getSetCookie();
    if (cookies.length) {
      const expected = options.production
        ? "__Host-leafivo_owner="
        : "leafivo_owner=";
      const next = cookies.filter((v) => v.startsWith(expected)).at(-1);
      if (next) cookie = next.split(";")[0];
    }
    return {
      status: response.status,
      body: await response.json(),
      headers: response.headers,
      cookie,
    };
  }
  async function start() {
    const r = await request("/api/owner/setup/start", {
      method: "POST",
      data: { setupToken: SETUP, username: "owner", password: PASSWORD },
    });
    assert.equal(r.status, 201);
    return r.body;
  }
  async function setup() {
    const flow = await start();
    const r = await request("/api/owner/setup/complete", {
      method: "POST",
      data: {
        flowToken: flow.flowToken,
        code: ownerTotp(flow.secret, timestamp),
      },
    });
    assert.equal(r.status, 201);
    return {
      ...r.body,
      secret: flow.secret,
      cookie: r.cookie,
      headers: r.headers,
    };
  }
  return {
    db,
    auth,
    request,
    start,
    setup,
    advance: (ms) => (timestamp += ms),
    setTime: (ms) => (timestamp = ms),
    time: () => timestamp,
    getCookie: () => cookie,
  };
}

const mutate = (data, csrf) => ({
  method: "POST",
  data,
  headers: { "X-CSRF-Token": csrf },
});

test("TOTP follows RFC 6238 SHA-1 vectors, including leading zeros", () => {
  const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  for (const [seconds, expected] of [
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ])
    assert.equal(ownerTotp(secret, seconds * 1000, 8), expected);
  assert.equal(ownerTotp(secret, 59000), "287082");
});

test("owner status exposes availability but never bootstrap or authentication secrets", async (t) => {
  const f = await fixture(t);
  const r = await f.request("/api/owner/session");
  assert.equal(r.status, 200);
  assert.equal(r.body.authenticated, false);
  assert.equal(r.body.configured, false);
  assert.equal(r.body.setupAvailable, true);
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.ok(!JSON.stringify(r.body).includes(SETUP));
  assert.ok(!JSON.stringify(r.body).includes(KEY));
  const missing = await fixture(t, { sessionKey: "" });
  assert.equal(
    (await missing.request("/api/owner/session")).body.available,
    false,
  );
  assert.equal(
    (
      await missing.request("/api/owner/setup/start", {
        method: "POST",
        data: {},
      })
    ).status,
    503,
  );
});

test("setup requires an exact trusted origin, valid bootstrap and strong bounded password", async (t) => {
  const f = await fixture(t);
  const data = { setupToken: SETUP, username: "owner", password: PASSWORD };
  for (const origin of ["https://attacker.invalid", "null", ""])
    assert.equal(
      (
        await f.request("/api/owner/setup/start", {
          method: "POST",
          origin,
          data,
        })
      ).status,
      403,
    );
  assert.equal(
    (
      await f.request("/api/owner/setup/start", {
        method: "POST",
        data: { ...data, setupToken: "wrong" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.request("/api/owner/setup/start", {
        method: "POST",
        data: { ...data, password: "short" },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.request("/api/owner/setup/start", {
        method: "POST",
        data: { ...data, password: "x".repeat(129) },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.request("/api/owner/setup/start", {
        method: "POST",
        data: { ...data, username: "<script>" },
      })
    ).status,
    400,
  );
});

test("two-phase setup verifies MFA, hashes credentials and session tokens, and is one-time", async (t) => {
  const f = await fixture(t);
  const flow = await f.start();
  assert.equal(flow.secret.length, 32);
  assert.match(flow.otpauthUrl, /^otpauth:\/\/totp\//);
  assert.equal(
    (
      await f.request("/api/owner/setup/complete", {
        method: "POST",
        data: { flowToken: flow.flowToken, code: "not-a-code" },
      })
    ).status,
    401,
  );
  const complete = await f.request("/api/owner/setup/complete", {
    method: "POST",
    data: { flowToken: flow.flowToken, code: ownerTotp(flow.secret, f.time()) },
  });
  assert.equal(complete.status, 201);
  assert.equal(complete.body.recoveryCodes.length, 10);
  const identity = f.db.prepare("SELECT * FROM owner_identity").get();
  assert.notEqual(identity.password_hash, PASSWORD);
  assert.ok(identity.password_hash.startsWith("scrypt$65536$8$2$"));
  assert.equal(identity.totp_secret.includes(flow.secret), false);
  assert.ok(await verifyOwnerPassword(PASSWORD, identity.password_hash));
  const session = f.db.prepare("SELECT * FROM owner_sessions").get();
  assert.notEqual(session.token_hash, complete.cookie.split("=")[1]);
  assert.equal(session.csrf_token.includes(complete.body.csrfToken), false);
  assert.match(complete.headers.get("set-cookie"), /HttpOnly/);
  assert.match(complete.headers.get("set-cookie"), /SameSite=Strict/);
  assert.equal(
    f.db.prepare("SELECT count(*) AS count FROM owner_setup_pending").get()
      .count,
    0,
  );
  const status = await f.request("/api/owner/session");
  assert.equal(status.body.authenticated, true);
  assert.equal(status.body.setupAvailable, false);
  assert.equal(status.body.owner.username, "owner");
  assert.equal(status.body.recoveryCodes, undefined);
  assert.equal(status.body.secret, undefined);
  assert.equal(
    (
      await f.request("/api/owner/setup/start", {
        method: "POST",
        data: { setupToken: SETUP, username: "intruder", password: PASSWORD },
      })
    ).status,
    403,
  );
});

test("production requires a secure configured origin and issues host-only secure cookies", async (t) => {
  const f = await fixture(t, { production: true });
  const owner = await f.setup();
  const cookie = owner.headers.get("set-cookie");
  assert.match(cookie, /^__Host-leafivo_owner=/);
  assert.match(cookie, /; Secure/);
  assert.match(cookie, /; HttpOnly/);
  assert.match(cookie, /; Path=\//);
  assert.match(cookie, /SameSite=Strict/);
  assert.doesNotMatch(cookie, /Domain=/);
  const invalid = await fixture(t, {
    production: true,
    origin: "http://owner.test",
  });
  assert.equal(
    (await invalid.request("/api/owner/session")).body.available,
    false,
  );
});

test("bootstrap and pending enrollment expire without creating an owner", async (t) => {
  const f = await fixture(t);
  const flow = await f.start();
  f.advance(10 * 60 * 1000 + 1);
  assert.equal(
    (
      await f.request("/api/owner/setup/complete", {
        method: "POST",
        data: {
          flowToken: flow.flowToken,
          code: ownerTotp(flow.secret, f.time()),
        },
      })
    ).status,
    403,
  );
  assert.equal(
    f.db.prepare("SELECT count(*) AS count FROM owner_identity").get().count,
    0,
  );
  f.advance(60 * 60 * 1000);
  assert.equal(
    (await f.request("/api/owner/session")).body.setupAvailable,
    false,
  );
  assert.equal(
    (
      await f.request("/api/owner/setup/start", {
        method: "POST",
        data: { setupToken: SETUP, username: "owner", password: PASSWORD },
      })
    ).status,
    403,
  );
});

test("login requires password and a fresh one-use authenticator code", async (t) => {
  const f = await fixture(t),
    owner = await f.setup();
  const login = (data) =>
    f.request("/api/owner/login", {
      method: "POST",
      sendCookie: false,
      data: { username: "owner", password: PASSWORD, ...data },
    });
  assert.equal(
    (
      await login({
        password: "wrong password",
        code: ownerTotp(owner.secret, f.time()),
      })
    ).status,
    401,
  );
  assert.equal((await login({})).status, 401);
  assert.equal(
    (await login({ code: ownerTotp(owner.secret, f.time()) })).status,
    401,
  );
  f.advance(30000);
  const code = ownerTotp(owner.secret, f.time());
  assert.equal((await login({ code })).status, 200);
  assert.equal((await login({ code })).status, 401);
});

test("simultaneous requests cannot reuse the same authenticator counter", async (t) => {
  const f = await fixture(t),
    owner = await f.setup();
  f.advance(30000);
  const data = {
    username: "owner",
    password: PASSWORD,
    code: ownerTotp(owner.secret, f.time()),
  };
  const results = await Promise.all([
    f.request("/api/owner/login", { method: "POST", sendCookie: false, data }),
    f.request("/api/owner/login", { method: "POST", sendCookie: false, data }),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 401]);
});

test("authenticated mutations require CSRF and origin; logout invalidates the server session", async (t) => {
  const f = await fixture(t),
    owner = await f.setup();
  assert.equal((await f.request("/protected")).status, 200);
  assert.equal(
    (await f.request("/protected", { method: "POST", data: {} })).status,
    403,
  );
  assert.equal(
    (await f.request("/protected", mutate({}, "wrong"))).status,
    403,
  );
  assert.equal(
    (
      await f.request("/protected", {
        ...mutate({}, owner.csrfToken),
        origin: "https://attacker.invalid",
      })
    ).status,
    403,
  );
  assert.equal(
    (await f.request("/protected", mutate({}, owner.csrfToken))).status,
    200,
  );
  assert.equal(
    (await f.request("/api/owner/logout", mutate({}, owner.csrfToken))).status,
    200,
  );
  assert.equal(
    f.db.prepare("SELECT count(*) AS count FROM owner_sessions").get().count,
    0,
  );
  assert.equal(
    (await f.request("/protected", { cookie: owner.cookie })).status,
    401,
  );
});

test("recovery codes are hashed and can be consumed only once", async (t) => {
  const f = await fixture(t),
    owner = await f.setup();
  const data = {
    username: "owner",
    password: PASSWORD,
    recoveryCode: owner.recoveryCodes[0],
  };
  assert.ok(
    !JSON.stringify(
      f.db.prepare("SELECT * FROM owner_recovery").all(),
    ).includes(owner.recoveryCodes[0].replace(/-/g, "")),
  );
  assert.equal(
    (
      await f.request("/api/owner/login", {
        method: "POST",
        sendCookie: false,
        data,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await f.request("/api/owner/login", {
        method: "POST",
        sendCookie: false,
        data,
      })
    ).status,
    401,
  );
  assert.equal(
    f.db.prepare("SELECT count(*) AS count FROM owner_recovery").get().count,
    9,
  );
});

test("sessions expire after inactivity and cannot be kept beyond the absolute lifetime", async (t) => {
  const f = await fixture(t);
  await f.setup();
  f.advance(15 * 60 * 1000);
  assert.equal((await f.request("/protected")).status, 401);
  const g = await fixture(t);
  await g.setup();
  for (let minutes = 14; minutes < 480; minutes += 14) {
    g.setTime(START + minutes * 60000);
    assert.equal((await g.request("/protected")).status, 200);
  }
  g.setTime(START + 8 * 60 * 60 * 1000);
  assert.equal((await g.request("/protected")).status, 401);
});

test("duplicate cookie names cannot create ambiguous authentication", async (t) => {
  const f = await fixture(t),
    owner = await f.setup();
  assert.equal(
    (
      await f.request("/protected", {
        cookie: `${owner.cookie}; ${owner.cookie}`,
      })
    ).status,
    401,
  );
});

test("password change needs a fresh code and revokes every existing session", async (t) => {
  const f = await fixture(t),
    first = await f.setup();
  const second = await f.request("/api/owner/login", {
    method: "POST",
    sendCookie: false,
    data: {
      username: "owner",
      password: PASSWORD,
      recoveryCode: first.recoveryCodes[0],
    },
  });
  assert.equal(second.status, 200);
  f.advance(30000);
  const changed = await f.request("/api/owner/passwordchange", {
    ...mutate(
      {
        currentPassword: PASSWORD,
        password: NEW_PASSWORD,
        code: ownerTotp(first.secret, f.time()),
      },
      first.csrfToken,
    ),
    cookie: first.cookie,
  });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.passwordChanged, true);
  assert.equal(
    (await f.request("/protected", { cookie: first.cookie })).status,
    401,
  );
  assert.equal(
    (await f.request("/protected", { cookie: second.cookie })).status,
    401,
  );
  assert.equal(
    (await f.request("/protected", { cookie: changed.cookie })).status,
    200,
  );
  assert.equal(
    f.db.prepare("SELECT count(*) AS count FROM owner_sessions").get().count,
    1,
  );
  f.advance(30000);
  const login = await f.request("/api/owner/login", {
    method: "POST",
    sendCookie: false,
    data: {
      username: "owner",
      password: NEW_PASSWORD,
      code: ownerTotp(first.secret, f.time()),
    },
  });
  assert.equal(login.status, 200);
});

test("authenticator recovery replaces the secret, recovery codes and all sessions", async (t) => {
  const f = await fixture(t),
    owner = await f.setup();
  const start = await f.request(
    "/api/owner/mfa/reset/start",
    mutate(
      { currentPassword: PASSWORD, recoveryCode: owner.recoveryCodes[0] },
      owner.csrfToken,
    ),
  );
  assert.equal(start.status, 201);
  assert.notEqual(start.body.secret, owner.secret);
  const reset = await f.request(
    "/api/owner/mfa/reset/complete",
    mutate(
      {
        flowToken: start.body.flowToken,
        code: ownerTotp(start.body.secret, f.time()),
      },
      owner.csrfToken,
    ),
  );
  assert.equal(reset.status, 200);
  assert.equal(reset.body.authenticatorChanged, true);
  assert.equal(reset.body.recoveryCodes.length, 10);
  assert.equal(
    (await f.request("/protected", { cookie: owner.cookie })).status,
    401,
  );
  assert.equal(
    (await f.request("/protected", { cookie: reset.cookie })).status,
    200,
  );
  assert.equal(
    f.db.prepare("SELECT count(*) AS count FROM owner_mfa_pending").get().count,
    0,
  );
  f.advance(30000);
  assert.equal(
    (
      await f.request("/api/owner/login", {
        method: "POST",
        sendCookie: false,
        data: {
          username: "owner",
          password: PASSWORD,
          code: ownerTotp(owner.secret, f.time()),
        },
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await f.request("/api/owner/login", {
        method: "POST",
        sendCookie: false,
        data: {
          username: "owner",
          password: PASSWORD,
          code: ownerTotp(start.body.secret, f.time()),
        },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await f.request("/api/owner/login", {
        method: "POST",
        sendCookie: false,
        data: {
          username: "owner",
          password: PASSWORD,
          recoveryCode: owner.recoveryCodes[1],
        },
      })
    ).status,
    401,
  );
});

test("recovery enrollment is session-bound and expires after ten minutes", async (t) => {
  const f = await fixture(t),
    owner = await f.setup();
  const start = await f.request(
    "/api/owner/mfa/reset/start",
    mutate(
      { currentPassword: PASSWORD, recoveryCode: owner.recoveryCodes[0] },
      owner.csrfToken,
    ),
  );
  assert.equal(start.status, 201);
  const other = await f.request("/api/owner/login", {
    method: "POST",
    sendCookie: false,
    data: {
      username: "owner",
      password: PASSWORD,
      recoveryCode: owner.recoveryCodes[1],
    },
  });
  assert.equal(other.status, 200);
  assert.equal(
    (
      await f.request(
        "/api/owner/mfa/reset/complete",
        mutate(
          {
            flowToken: start.body.flowToken,
            code: ownerTotp(start.body.secret, f.time()),
          },
          other.body.csrfToken,
        ),
      )
    ).status,
    403,
  );
  f.advance(10 * 60 * 1000 + 1);
  assert.equal(
    (
      await f.request("/api/owner/mfa/reset/complete", {
        ...mutate(
          {
            flowToken: start.body.flowToken,
            code: ownerTotp(start.body.secret, f.time()),
          },
          owner.csrfToken,
        ),
        cookie: owner.cookie,
      })
    ).status,
    403,
  );
});

test("owner login brute-force budgets return Retry-After and keep failed logins unauthenticated", async (t) => {
  const f = await fixture(t);
  await f.setup();
  for (let i = 0; i < 5; i++)
    assert.equal(
      (
        await f.request("/api/owner/login", {
          method: "POST",
          sendCookie: false,
          data: {
            username: "owner",
            password: "incorrect but long password",
            code: "000000",
          },
        })
      ).status,
      401,
    );
  const limited = await f.request("/api/owner/login", {
    method: "POST",
    sendCookie: false,
    data: { username: "owner", password: PASSWORD, code: "000000" },
  });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get("retry-after")) > 0);
});
