import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/index.js";

const ADMIN = "public-preview-test-owner-key-not-for-production";

async function fixture(t, options = {}) {
  const app = createApp({
    dbPath: ":memory:",
    mode: "preview",
    publicPreview: true,
    adminToken: ADMIN,
    stripeSecretKey: "",
    stripeWebhookSecret: "",
    production: true,
    baseUrl: "https://preview.example",
    ...options,
  });
  const server = await new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    app.locals.close();
  });
  const call = async (path, { method = "GET", data, headers = {} } = {}) => {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}${path}`,
      {
        method,
        headers: {
          ...(data !== undefined ? { "Content-Type": "application/json" } : {}),
          ...headers,
        },
        ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
      },
    );
    return { status: response.status, body: await response.json() };
  };
  return { app, call };
}

const bag = [{ productId: "the-art-of-starting", quantity: 2 }];

test("public preview is disclosed by both health and catalog responses", async (t) => {
  const { call } = await fixture(t);
  for (const path of ["/api/health", "/api/store"]) {
    const response = await call(path);
    assert.equal(response.status, 200);
    assert.equal(response.body.mode, "preview");
    assert.equal(response.body.publicPreview, true);
  }
  const catalog = await call("/api/store");
  assert.equal(catalog.body.products.length, 6);
  assert.ok(catalog.body.products.every((product) => product.sample));
});

test("public practice checkout needs no email, uses catalog prices, and stores no order", async (t) => {
  const { app, call } = await fixture(t);
  const response = await call("/api/checkout", {
    method: "POST",
    data: { items: bag, total: 1 },
  });
  assert.equal(response.status, 201);
  assert.equal(response.body.mode, "preview");
  assert.equal(response.body.persisted, false);
  assert.equal(response.body.order.total, 4800);
  assert.equal(response.body.order.status, "preview");
  assert.equal(response.body.order.currency, "usd");
  assert.match(response.body.message, /no payment/i);
  assert.match(
    response.body.message,
    /not saved|nothing.*saved|no.*saved|no.*stor/i,
  );
  assert.equal(app.locals.store.order(response.body.order.id), undefined);
  const overview = app.locals.store.overview();
  assert.equal(overview.stats.previewOrders, 0);
  assert.equal(overview.stats.paidOrders, 0);
  assert.equal(overview.stats.subscribers, 0);
  assert.equal(overview.stats.revenue, 0);
});

test("emails sent to public preview checkout are neither persisted nor returned", async (t) => {
  const { app, call } = await fixture(t);
  const email = "private-reader@example.com";
  const response = await call("/api/checkout", {
    method: "POST",
    data: { email, items: bag },
  });
  assert.equal(response.status, 201);
  assert.equal(response.body.persisted, false);
  assert.ok(!JSON.stringify(response.body).includes(email));
  assert.equal(
    app.locals.store.db.prepare("SELECT count(*) AS count FROM orders").get()
      .count,
    0,
  );
});

test("public preview cannot collect newsletter addresses even with explicit consent", async (t) => {
  const { app, call } = await fixture(t);
  const response = await call("/api/newsletter", {
    method: "POST",
    data: { email: "reader@example.com", consent: true },
  });
  assert.equal(response.status, 503);
  assert.match(response.body.error, /preview|disabled|not available/i);
  assert.equal(app.locals.store.overview().stats.subscribers, 0);
});

test("public preview disables every management endpoint even with the valid owner key", async (t) => {
  const { app, call } = await fixture(t);
  const headers = { Authorization: `Bearer ${ADMIN}` };
  const cases = [
    ["GET", "/api/admin/overview", undefined],
    [
      "POST",
      "/api/admin/products",
      { title: "Unwanted new listing", description: "Must not be stored" },
    ],
    [
      "PUT",
      "/api/admin/products/the-art-of-starting",
      { title: "Unwanted edit" },
    ],
    ["DELETE", "/api/admin/products/the-art-of-starting", undefined],
  ];
  for (const [method, path, data] of cases) {
    assert.equal(
      (await call(path, { method, data, headers })).status,
      403,
      `${method} ${path}`,
    );
  }
  assert.equal((await call("/api/admin/overview")).status, 403);
  assert.equal(app.locals.store.products().length, 6);
  assert.equal(
    app.locals.store.product("the-art-of-starting").title,
    "The Art of Starting",
  );
});

test("public preview and live payments cannot be combined or create a database", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "leafivo-preview-mode-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, "not-created", "store.sqlite");
  assert.throws(
    () => createApp({ publicPreview: true, mode: "live", dbPath }),
    /public.*preview|preview.*live|preview.*mode/i,
  );
  assert.equal(existsSync(dbPath), false);
});

test("private local preview retains authenticated management and persisted practice orders", async (t) => {
  const { app, call } = await fixture(t, {
    publicPreview: false,
    production: false,
  });
  assert.equal((await call("/api/store")).body.publicPreview, false);
  assert.equal(
    (
      await call("/api/admin/overview", {
        headers: { Authorization: `Bearer ${ADMIN}` },
      })
    ).status,
    200,
  );
  const response = await call("/api/checkout", {
    method: "POST",
    data: { email: "owner-test@example.com", items: bag },
  });
  assert.equal(response.status, 201);
  assert.equal(app.locals.store.overview().stats.previewOrders, 1);
  assert.equal(
    app.locals.store.order(response.body.order.id).email,
    "owner-test@example.com",
  );
});

function setEnvironment(t, values) {
  const originals = Object.fromEntries(
    Object.keys(values).map((key) => [key, process.env[key]]),
  );
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(originals)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test("Render's generated public URL supplies the trusted origin when no public URL is configured", async (t) => {
  setEnvironment(t, {
    PUBLIC_BASE_URL: "",
    RENDER_EXTERNAL_URL: "https://leafivo-test.onrender.com",
  });
  const { call } = await fixture(t, { baseUrl: undefined });
  const permitted = await call("/api/checkout", {
    method: "POST",
    headers: { Origin: "https://leafivo-test.onrender.com" },
    data: { items: bag },
  });
  assert.equal(permitted.status, 201);
  const hostile = await call("/api/checkout", {
    method: "POST",
    headers: { Origin: "https://other.onrender.com" },
    data: { items: bag },
  });
  assert.equal(hostile.status, 403);
});

test("an explicit public URL takes precedence over the generated Render URL", async (t) => {
  setEnvironment(t, {
    PUBLIC_BASE_URL: "https://shop.example",
    RENDER_EXTERNAL_URL: "https://leafivo-test.onrender.com",
  });
  const { call } = await fixture(t, { baseUrl: undefined });
  assert.equal(
    (
      await call("/api/checkout", {
        method: "POST",
        headers: { Origin: "https://shop.example" },
        data: { items: bag },
      })
    ).status,
    201,
  );
  assert.equal(
    (
      await call("/api/checkout", {
        method: "POST",
        headers: { Origin: "https://leafivo-test.onrender.com" },
        data: { items: bag },
      })
    ).status,
    403,
  );
});

test("public preview cannot expose pre-existing receipt or download capabilities", async (t) => {
  const { app, call } = await fixture(t);
  const id = "previous-private-order";
  const token = "a-private-receipt-token";
  const productId = "the-art-of-starting";
  app.locals.store.saveOrder({
    id,
    token,
    email: "private-buyer@example.com",
    status: "paid",
    total: 2400,
    currency: "usd",
    items: [
      {
        productId,
        title: "Private purchase",
        price: 2400,
        quantity: 1,
        downloadFile: "private.pdf",
      },
    ],
  });
  const receipt = await call(`/api/orders/${id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(receipt.status, 404);
  assert.ok(!JSON.stringify(receipt.body).includes("Private purchase"));
  const expires = Date.now() + 60 * 60 * 1000;
  const signature = createHmac("sha256", ADMIN)
    .update(`${id}:${productId}:${expires}`)
    .digest("hex");
  const download = await call(
    `/api/downloads/${id}/${productId}?expires=${expires}&signature=${signature}`,
  );
  assert.equal(download.status, 404);
});
