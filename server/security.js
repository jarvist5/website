import { existsSync, realpathSync } from "node:fs";
import { resolve, dirname, basename, relative, isAbsolute } from "node:path";
const containsPath = (parent, child) => {
  const rel = relative(parent, child);
  return (
    rel === "" ||
    (rel !== ".." &&
      !rel.startsWith(".." + (process.platform === "win32" ? "\\" : "/")) &&
      !isAbsolute(rel))
  );
};
const canonicalTarget = (value) => {
  let current = resolve(value);
  const suffix = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    suffix.unshift(basename(current));
    current = parent;
  }
  return resolve(realpathSync(current), ...suffix);
};

// Same-origin browser protection supplements bearer authentication; it does not replace it.
export function publicOrigin(value) {
  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function securityHeaders(production) {
  return (req, res, next) => {
    res.set({
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
      "Permissions-Policy":
        "camera=(), microphone=(), geolocation=(), payment=()",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Resource-Policy": "same-origin",
      "X-Permitted-Cross-Domain-Policies": "none",
    });
    if (production) {
      res.set(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      );
      // req.secure only trusts forwarded protocol when trusted proxy hops are configured.
      if (req.secure) res.set("Strict-Transport-Security", "max-age=31536000");
    }
    if (req.path.startsWith("/api/")) res.set("Cache-Control", "no-store");
    next();
  };
}

export function protectBrowserMutations(configuredOrigin) {
  return (req, res, next) => {
    if (
      !req.path.startsWith("/api/") ||
      !["POST", "PUT", "PATCH", "DELETE"].includes(req.method) ||
      req.path === "/api/webhooks/stripe"
    )
      return next();
    const origin = req.get("Origin");
    const expected =
      configuredOrigin || publicOrigin(`${req.protocol}://${req.get("host")}`);
    if (
      req.get("Sec-Fetch-Site") === "cross-site" ||
      (origin && (!expected || origin !== expected))
    )
      return res
        .status(403)
        .json({ error: "Cross-site requests are not permitted." });
    if (req.method !== "DELETE" && !req.is("application/json"))
      return res
        .status(415)
        .json({ error: "Send this request as application/json." });
    next();
  };
}

export function denyPrivatePaths(req, res, next) {
  let segments;
  try {
    segments = decodeURIComponent(req.path).split("/").filter(Boolean);
  } catch {
    return res.status(400).json({ error: "Invalid request path." });
  }
  const reserved = new Set([
    "private-downloads",
    "node_modules",
    "server",
    "src",
  ]);
  if (
    segments.some((segment) => segment.startsWith(".")) ||
    reserved.has(segments[0])
  )
    return res.status(404).json({ error: "Not found." });
  next();
}

// Fail closed if a storage setting (including an existing symlink) would publish private data.
export function assertPrivateStoragePaths({ dbPath, downloadDir, publicDirs }) {
  const publicPaths = publicDirs.map(canonicalTarget);
  const download = canonicalTarget(downloadDir);
  const database = dbPath === ":memory:" ? null : canonicalTarget(dbPath);
  for (const webRoot of publicPaths) {
    if (
      containsPath(webRoot, download) ||
      containsPath(download, webRoot) ||
      (database && containsPath(webRoot, database))
    )
      throw new Error(
        "Private storage must be outside all public asset directories.",
      );
  }
}
