import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../server/index.js";
import { mkdtempSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

async function fixture(t, options = {}) {
  const app = createApp({
    dbPath: ":memory:",
    adminToken: "http-test-admin-only-not-for-production",
    mode: "preview",
    production: true,
    baseUrl: "https://store.example",
    stripeSecretKey: "",
    stripeWebhookSecret: "",
    ...options,
  });
  const server = await new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    app.locals.close();
  });
  return {
    app,
    call: async (path, init = {}) => {
      const response = await fetch(
        `http://127.0.0.1:${server.address().port}${path}`,
        init,
      );
      const text = await response.text();
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
      return { status: response.status, headers: response.headers, body };
    },
  };
}
const signup = (headers = {}, email = "reader@example.com") => ({
  method: "POST",
  headers: { "Content-Type": "application/json", ...headers },
  body: JSON.stringify({ email, consent: true }),
});

test("production responses restrict scripts, framing, browser permissions, referrers and caching", async (t) => {
  const { call } = await fixture(t);
  const r = await call("/api/store");
  assert.equal(r.status, 200);
  const csp = r.headers.get("content-security-policy");
  for (const directive of [
    "script-src 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ])
    assert.ok(csp.includes(directive));
  assert.ok(!csp.includes("unsafe-inline") && !csp.includes("unsafe-eval"));
  assert.equal(r.headers.get("x-frame-options"), "DENY");
  assert.equal(r.headers.get("referrer-policy"), "no-referrer");
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.match(r.headers.get("permissions-policy"), /camera=\(\)/);
  assert.equal(r.headers.get("access-control-allow-origin"), null);
  for (const path of ["/", "/index.html"]) {
    const html = await call(path);
    if (html.status === 200)
      assert.equal(html.headers.get("cache-control"), "no-store");
  }
});

test("HSTS requires verified HTTPS through explicitly trusted proxy hops", async (t) => {
  const direct = await fixture(t);
  assert.equal(
    (
      await direct.call("/api/health", {
        headers: { "X-Forwarded-Proto": "https" },
      })
    ).headers.get("strict-transport-security"),
    null,
  );
  const proxied = await fixture(t, { trustProxyHops: 1 });
  assert.equal(
    (
      await proxied.call("/api/health", {
        headers: { "X-Forwarded-Proto": "https" },
      })
    ).headers.get("strict-transport-security"),
    "max-age=31536000",
  );
});

test("cross-site and null-origin mutations cannot create signups, even with consent", async (t) => {
  const { app, call } = await fixture(t);
  for (const headers of [
    { Origin: "https://attacker.example" },
    { Origin: "null" },
    { Origin: "https://store.example", "Sec-Fetch-Site": "cross-site" },
  ])
    assert.equal((await call("/api/newsletter", signup(headers))).status, 403);
  assert.equal(app.locals.store.overview().stats.subscribers, 0);
  assert.equal(
    (await call("/api/newsletter", signup({ Origin: "https://store.example" })))
      .status,
    201,
  );
});

test("cross-site authenticated writes are blocked without removing owner authentication", async (t) => {
  const { call } = await fixture(t);
  const data = { title: "An unauthorized change" };
  assert.equal(
    (
      await call("/api/admin/products/the-art-of-starting", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://attacker.example",
          Authorization: "Bearer http-test-admin-only-not-for-production",
        },
        body: JSON.stringify(data),
      })
    ).status,
    403,
  );
  assert.equal(
    (await call("/api/products/the-art-of-starting")).body.title,
    "The Art of Starting",
  );
  assert.equal((await call("/api/admin/overview")).status, 401);
});

test("private server paths and encoded dotfiles never fall back to the public app", async (t) => {
  const { call } = await fixture(t);
  for (const path of [
    "/.env",
    "/.git/config",
    "/.data/store.sqlite",
    "/private-downloads/book.pdf",
    "/server/index.js",
    "/node_modules/stripe/package.json",
    "/%2eenv",
  ]) {
    const r = await call(path);
    assert.equal(r.status, 404, path);
    assert.equal(r.body.error, "Not found.");
  }
});

test("non-JSON writes, oversized bodies and long pathological emails fail safely", async (t) => {
  const { call } = await fixture(t);
  assert.equal(
    (
      await call("/api/newsletter", {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: "email=reader@example.com",
      })
    ).status,
    415,
  );
  const large = await call("/api/newsletter", signup({}, "x".repeat(30000)));
  assert.equal(large.status, 413);
  assert.deepEqual(large.body, { error: "Request is too large." });
  const pathological = "a@" + "a.".repeat(9900) + " x";
  assert.equal(
    (await call("/api/newsletter", signup({}, pathological))).status,
    400,
  );
  assert.equal(
    (
      await call(
        "/api/newsletter",
        signup({}, "x".repeat(255) + "@example.com"),
      )
    ).status,
    400,
  );
});

test("throttled writes provide Retry-After and never persist the extra request", async (t) => {
  const { call, app } = await fixture(t);
  for (let i = 0; i < 10; i++)
    assert.equal(
      (await call("/api/newsletter", signup({}, `reader${i}@example.com`)))
        .status,
      201,
    );
  const limited = await call(
    "/api/newsletter",
    signup({}, "too-many@example.com"),
  );
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get("retry-after")) > 0);
  assert.equal(app.locals.store.overview().stats.subscribers, 10);
});

test("live checkout rejects malformed public origins rather than trusting an HTTPS prefix", async (t) => {
  for (const baseUrl of [
    "https://owner:secret@store.example",
    "https://store.example/?redirect=x",
    "https://store.example/path",
  ]) {
    const { call } = await fixture(t, {
      mode: "live",
      stripeSecretKey: "sk_test_placeholder",
      stripeWebhookSecret: "whsec_placeholder",
      baseUrl,
    });
    assert.equal((await call("/api/health")).body.checkoutEnabled, false);
  }
});

test("storage misconfiguration cannot expose customer databases or downloads through public assets", () => {
  for (const options of [
    { dbPath: resolve("public", "exposed.sqlite") },
    { dbPath: resolve("dist", "exposed.sqlite") },
    { downloadDir: resolve("public", "paid-files") },
    { downloadDir: resolve("dist") },
    { downloadDir: resolve(".") },
  ])
    assert.throws(
      () => createApp({ dbPath: ":memory:", ...options }),
      /Private storage must be outside/,
    );
});

test("storage checks resolve symlink targets before accepting a private directory", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "leafivo-storage-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  symlinkSync(resolve("public"), join(dir, "disguised-private"), "dir");
  assert.throws(
    () =>
      createApp({
        dbPath: ":memory:",
        downloadDir: join(dir, "disguised-private", "files"),
      }),
    /Private storage must be outside/,
  );
});
