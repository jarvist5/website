import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp } from "../server/index.js";
import { ownerTotp } from "../server/owner-auth.js";
const setupToken = "integration-test-bootstrap-not-a-real-key";
async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "leafivo-owner-integration-"));
  const app = createApp({
    dbPath: join(dir, "store.sqlite"),
    downloadDir: join(dir, "private"),
    production: false,
    publicPreview: true,
    mode: "preview",
    ownerManagementEnabled: true,
    ownerStoragePersistent: true,
    ownerAuthKey: "integration-test-encryption-key-32bytes",
    ownerSetupToken: setupToken,
    ownerSetupExpires: Date.now() + 3600000,
    baseUrl: "http://owner.example",
    stripeSecretKey: "",
    stripeWebhookSecret: "",
  });
  const server = await new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    app.locals.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const request = async (
    path,
    { method = "GET", data, cookie, csrf, headers = {}, body } = {},
  ) => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method,
      headers: {
        ...(method === "GET" ? {} : { Origin: "http://owner.example" }),
        ...(data ? { "Content-Type": "application/json" } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...(csrf ? { "X-CSRF-Token": csrf } : {}),
        ...headers,
      },
      body: data ? JSON.stringify(data) : body,
    });
    const text = await r.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
    return {
      status: r.status,
      body: payload,
      cookie: r.headers.get("set-cookie")?.split(";")[0],
      headers: r.headers,
    };
  };
  const start = await request("/api/owner/setup/start", {
    method: "POST",
    data: {
      setupToken,
      username: "store_owner",
      password: "A strong integration passphrase 27!",
    },
  });
  assert.equal(start.status, 201);
  const complete = await request("/api/owner/setup/complete", {
    method: "POST",
    data: {
      flowToken: start.body.flowToken,
      code: ownerTotp(start.body.secret, Date.now() - 30000),
    },
  });
  assert.equal(complete.status, 201);
  return {
    app,
    request,
    dir,
    cookie: complete.cookie,
    csrf: complete.body.csrfToken,
    secret: start.body.secret,
  };
}

test("public customers remain in preview while the MFA owner can manage the catalog", async (t) => {
  const { app, request, cookie, csrf } = await fixture(t);
  const publicStore = await request("/api/store");
  assert.equal(publicStore.body.publicPreview, true);
  assert.equal(publicStore.body.ownerAccess, true);
  assert.equal((await request("/api/admin/overview")).status, 401);
  const owner = await request("/api/admin/overview", { cookie });
  assert.equal(owner.status, 200);
  assert.equal(owner.body.products.length, 6);
  const post = {
    method: "POST",
    data: {
      title: "My owned ebook",
      description: "An educational workbook",
      price: 2500,
    },
    cookie,
  };
  assert.equal((await request("/api/admin/products", post)).status, 403);
  const product = await request("/api/admin/products", { ...post, csrf });
  assert.equal(product.status, 201);
  assert.equal(product.body.price, 2500);
  assert.equal(
    (
      await request("/api/newsletter", {
        method: "POST",
        data: { email: "test@example.invalid", consent: true },
      })
    ).status,
    503,
  );
  const checkout = await request("/api/checkout", {
    method: "POST",
    data: { items: [{ productId: product.body.id, quantity: 1 }] },
  });
  assert.equal(checkout.status, 201);
  assert.equal(checkout.body.persisted, false);
  assert.equal(app.locals.store.overview().stats.previewOrders, 0);
  const signedOut = await request("/api/owner/logout", {
    method: "POST",
    cookie,
    csrf,
    data: {},
  });
  assert.equal(signedOut.status, 200);
  assert.equal((await request("/api/admin/overview", { cookie })).status, 401);
});

test("private ebook upload requires owner cookie, CSRF and content rights before exposing any file", async (t) => {
  const { request, cookie, csrf, dir } = await fixture(t);
  const filePath = "/api/admin/products/the-art-of-starting/file";
  const pdf = Buffer.from("%PDF-1.7\nOwned educational sample\n%%EOF");
  const headers = {
    "Content-Type": "application/pdf",
    "X-Content-Rights": "owned-or-licensed",
  };
  assert.equal(
    (await request(filePath, { method: "PUT", headers, body: pdf })).status,
    401,
  );
  assert.equal(
    (await request(filePath, { method: "PUT", headers, body: pdf, cookie }))
      .status,
    403,
  );
  assert.equal(
    (
      await request(filePath, {
        method: "PUT",
        headers: { "Content-Type": "application/pdf" },
        body: pdf,
        cookie,
        csrf,
      })
    ).status,
    400,
  );
  const upload = await request(filePath, {
    method: "PUT",
    headers,
    body: pdf,
    cookie,
    csrf,
  });
  assert.equal(upload.status, 200);
  assert.equal(upload.body.product.downloadReady, true);
  assert.ok(!("downloadFile" in upload.body.product));
  assert.equal((await request(filePath)).status, 401);
  const review = await request(filePath, { cookie });
  assert.equal(review.status, 200);
  assert.equal(review.body, pdf.toString());
  assert.match(review.headers.get("content-disposition"), /attachment/);
  const filename = readdirSync(join(dir, "private"))[0];
  assert.equal((await request("/private-downloads/" + filename)).status, 404);
  const publish = await request("/api/admin/products/the-art-of-starting", {
    method: "PUT",
    data: { sample: false },
    cookie,
    csrf,
  });
  assert.equal(publish.status, 200);
  assert.equal(publish.body.sample, false);
});

test("production owner access cannot be enabled on an undeclared ephemeral filesystem", () => {
  assert.throws(
    () =>
      createApp({
        dbPath: ":memory:",
        production: true,
        ownerManagementEnabled: true,
        ownerStoragePersistent: false,
      }),
    /permanent storage/,
  );
});

test("production legacy bearer keys cannot bypass the new owner authentication boundary", async (t) => {
  const app = createApp({
    dbPath: ":memory:",
    production: true,
    publicPreview: false,
    mode: "preview",
    adminToken: "legacy-test-token-no-production-authority",
    baseUrl: "https://owner.example",
  });
  const server = await new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    app.locals.close();
  });
  const response = await fetch(
    `http://127.0.0.1:${server.address().port}/api/admin/overview`,
    {
      headers: {
        Authorization: "Bearer legacy-test-token-no-production-authority",
      },
    },
  );
  assert.equal(response.status, 503);
});
