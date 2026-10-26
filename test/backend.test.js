import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Stripe from "stripe";
import { createApp } from "../server/index.js";
import { createStore } from "../server/store.js";

const ADMIN = "test-admin-token-with-32-characters";

async function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "chapter-test-"));
  const downloads = join(dir, "downloads");
  mkdirSync(downloads);
  const app = createApp({
    dbPath: join(dir, "test.sqlite"),
    adminToken: ADMIN,
    mode: "preview",
    downloadDir: downloads,
    ...options,
  });
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    app.locals.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const request = async (
    path,
    { method = "GET", data, auth, body, headers = {} } = {},
  ) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(data ? { "Content-Type": "application/json" } : {}),
        ...(auth
          ? { Authorization: `Bearer ${auth === true ? ADMIN : auth}` }
          : {}),
        ...headers,
      },
      body: data ? JSON.stringify(data) : body,
    });
    const payload = response.headers
      .get("content-type")
      ?.includes("application/json")
      ? await response.json()
      : await response.text();
    return {
      status: response.status,
      body: payload,
      headers: response.headers,
    };
  };
  return { app, request, dir, downloads };
}

test("catalog identifies sample products and does not expose private paths", async (t) => {
  const { request } = await fixture(t);
  const response = await request("/api/store");
  assert.equal(response.status, 200);
  assert.equal(response.body.mode, "preview");
  assert.equal(response.body.products.length, 6);
  assert.ok(
    response.body.products.every(
      (p) => p.sample && !("downloadFile" in p) && p.currency === "usd",
    ),
  );
  assert.equal((await request("/api/products/does-not-exist")).status, 404);
});

test("preview checkout calculates authoritative prices and never marks an order paid", async (t) => {
  const { request } = await fixture(t);
  const response = await request("/api/checkout", {
    method: "POST",
    data: {
      email: "buyer@example.com",
      total: 1,
      items: [{ productId: "the-art-of-starting", quantity: 2, price: 1 }],
    },
  });
  assert.equal(response.status, 201);
  assert.equal(response.body.mode, "preview");
  assert.equal(response.body.order.total, 4800);
  assert.equal(response.body.order.status, "preview");
  assert.match(response.body.message, /No payment was taken/);
  const overview = await request("/api/admin/overview", { auth: true });
  assert.equal(overview.body.stats.previewOrders, 1);
  assert.equal(overview.body.stats.paidOrders, 0);
  assert.equal(overview.body.stats.revenue, 0);
});

test("checkout rejects malformed quantities, duplicates, unknown products, and invalid email", async (t) => {
  const { request } = await fixture(t);
  for (const items of [
    [],
    [{ productId: "the-art-of-starting", quantity: 0 }],
    [{ productId: "the-art-of-starting", quantity: 1.5 }],
    [{ productId: "the-art-of-starting", quantity: 11 }],
    [{ productId: "missing", quantity: 1 }],
    [
      { productId: "the-art-of-starting", quantity: 1 },
      { productId: "the-art-of-starting", quantity: 1 },
    ],
  ]) {
    assert.equal(
      (
        await request("/api/checkout", {
          method: "POST",
          data: { email: "a@example.com", items },
        })
      ).status,
      400,
    );
  }
  assert.equal(
    (
      await request("/api/checkout", {
        method: "POST",
        data: {
          email: "bad",
          items: [{ productId: "the-art-of-starting", quantity: 1 }],
        },
      })
    ).status,
    400,
  );
  assert.equal(
    (await request("/api/checkout", { method: "POST", data: {} })).status,
    400,
  );
});

test("newsletter requires explicit consent and deduplicates normalized emails", async (t) => {
  const { request } = await fixture(t);
  assert.equal(
    (
      await request("/api/newsletter", {
        method: "POST",
        data: { email: "person@example.com" },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request("/api/newsletter", {
        method: "POST",
        data: { email: "invalid", consent: true },
      })
    ).status,
    400,
  );
  for (const email of ["Person@Example.com", "person@example.com"])
    assert.equal(
      (
        await request("/api/newsletter", {
          method: "POST",
          data: { email, consent: true },
        })
      ).status,
      201,
    );
  const overview = await request("/api/admin/overview", { auth: true });
  assert.equal(overview.body.stats.subscribers, 1);
  assert.equal(overview.body.subscribers[0].email, "person@example.com");
});

test("management data requires a sufficiently strong administrator token", async (t) => {
  const { request } = await fixture(t);
  assert.equal((await request("/api/admin/overview")).status, 401);
  assert.equal(
    (await request("/api/admin/overview", { auth: "wrong-token" })).status,
    401,
  );
  const response = await request("/api/admin/overview", { auth: true });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const weak = await fixture(t, { adminToken: "short" });
  assert.equal(
    (await weak.request("/api/admin/overview", { auth: "short" })).status,
    503,
  );
});

test("product edits persist and reject invalid or unsupported data", async (t) => {
  const { request } = await fixture(t);
  const path = "/api/admin/products/the-art-of-starting";
  assert.equal(
    (await request(path, { method: "PUT", data: { price: 5000 } })).status,
    401,
  );
  assert.equal(
    (await request(path, { method: "PUT", auth: true, data: { price: -1 } }))
      .status,
    400,
  );
  assert.equal(
    (await request(path, { method: "PUT", auth: true, data: { id: "new-id" } }))
      .status,
    400,
  );
  assert.equal(
    (
      await request(path, {
        method: "PUT",
        auth: true,
        data: { sample: false },
      })
    ).status,
    400,
  );
  const saved = await request(path, {
    method: "PUT",
    auth: true,
    data: { price: 2800, title: "A Real Title" },
  });
  assert.equal(saved.status, 200);
  assert.equal(
    (await request("/api/products/the-art-of-starting")).body.price,
    2800,
  );
});

test("owners can add and remove listings without exposing immutable fields", async (t) => {
  const { request } = await fixture(t);
  const data = {
    title: "My own ebook",
    description: "A real product description",
    price: 2500,
  };
  assert.equal(
    (await request("/api/admin/products", { method: "POST", data })).status,
    401,
  );
  assert.equal(
    (
      await request("/api/admin/products", {
        method: "POST",
        auth: true,
        data: { ...data, id: "injected" },
      })
    ).status,
    400,
  );
  const response = await request("/api/admin/products", {
    method: "POST",
    auth: true,
    data,
  });
  assert.equal(response.status, 201);
  assert.match(response.body.id, /^my-own-ebook-/);
  assert.equal(response.body.sample, true);
  assert.equal(
    (await request(`/api/products/${response.body.id}`)).status,
    200,
  );
  assert.equal(
    (
      await request(`/api/admin/products/${response.body.id}`, {
        method: "DELETE",
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await request(`/api/admin/products/${response.body.id}`, {
        method: "DELETE",
        auth: true,
      })
    ).status,
    200,
  );
  assert.equal(
    (await request(`/api/products/${response.body.id}`)).status,
    404,
  );
});

test("deleted sample products do not reappear after a database restart", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "leafivo-persistence-"));
  const path = join(dir, "store.sqlite");
  let store = createStore(path);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  store.deleteProduct("the-art-of-starting");
  store.close();
  store = createStore(path);
  assert.equal(store.products().length, 5);
  assert.equal(store.product("the-art-of-starting"), null);
});

test("file paths are confined to the private directory including symlink targets", async (t) => {
  const { request, downloads, dir } = await fixture(t);
  const path = "/api/admin/products/the-art-of-starting";
  writeFileSync(join(dir, "outside.pdf"), "private outside file");
  symlinkSync(join(dir, "outside.pdf"), join(downloads, "escape.pdf"));
  for (const downloadFile of [
    "../outside.pdf",
    join(dir, "outside.pdf"),
    "escape.pdf",
  ])
    assert.equal(
      (
        await request(path, {
          method: "PUT",
          auth: true,
          data: { sample: false, downloadFile },
        })
      ).status,
      400,
    );
  writeFileSync(join(downloads, "book.pdf"), "real private content");
  const response = await request(path, {
    method: "PUT",
    auth: true,
    data: { sample: false, downloadFile: "book.pdf" },
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.sample, false);
  assert.equal(response.body.downloadReady, true);
  assert.equal("downloadFile" in response.body, false);
});

test("live mode fails closed without payment configuration and blocks sample products", async (t) => {
  const missing = await fixture(t, {
    mode: "live",
    stripeSecretKey: "",
    stripeWebhookSecret: "",
    baseUrl: "",
  });
  assert.equal(
    (await missing.request("/api/health")).body.checkoutEnabled,
    false,
  );
  const checkout = {
    method: "POST",
    data: {
      email: "person@example.com",
      items: [{ productId: "the-art-of-starting", quantity: 1 }],
    },
  };
  assert.equal((await missing.request("/api/checkout", checkout)).status, 503);
  const configured = await fixture(t, {
    mode: "live",
    stripeSecretKey: "sk_test_fake",
    stripeWebhookSecret: "whsec_fake",
    baseUrl: "https://example.com",
  });
  assert.equal(
    (await configured.request("/api/checkout", checkout)).status,
    409,
  );
});

test("JSON errors do not expose stack traces or server internals", async (t) => {
  const { request } = await fixture(t);
  const response = await request("/api/newsletter", {
    method: "POST",
    body: "{bad",
    headers: { "Content-Type": "application/json" },
  });
  assert.equal(response.status, 400);
  assert.deepEqual(response.body, { error: "Invalid JSON request." });
  assert.equal((await request("/api/unknown")).status, 404);
});

test("newsletter rate limit prevents an unbounded request stream", async (t) => {
  const { request } = await fixture(t);
  for (let i = 0; i < 10; i++)
    assert.equal(
      (
        await request("/api/newsletter", {
          method: "POST",
          data: { email: `person${i}@example.com`, consent: true },
        })
      ).status,
      201,
    );
  assert.equal(
    (
      await request("/api/newsletter", {
        method: "POST",
        data: { email: "person11@example.com", consent: true },
      })
    ).status,
    429,
  );
});

test("forwarded client IPs are trusted only when proxy hops are explicitly configured", async (t) => {
  const untrusted = await fixture(t);
  for (let i = 0; i < 10; i++)
    assert.equal(
      (
        await untrusted.request("/api/newsletter", {
          method: "POST",
          data: { email: `visitor${i}@example.com`, consent: true },
          headers: { "X-Forwarded-For": `192.0.2.${i + 1}` },
        })
      ).status,
      201,
    );
  assert.equal(
    (
      await untrusted.request("/api/newsletter", {
        method: "POST",
        data: { email: "another@example.com", consent: true },
        headers: { "X-Forwarded-For": "192.0.2.99" },
      })
    ).status,
    429,
  );
  const trusted = await fixture(t, { trustProxyHops: 1 });
  for (let i = 0; i < 11; i++)
    assert.equal(
      (
        await trusted.request("/api/newsletter", {
          method: "POST",
          data: { email: `visitor${i}@example.com`, consent: true },
          headers: { "X-Forwarded-For": `192.0.2.${i + 1}` },
        })
      ).status,
      201,
    );
});

test("only a verified matching paid webhook can unlock product downloads", async (t) => {
  const secret = "whsec_local_test_secret";
  const signer = new Stripe("sk_test_fake");
  let receiptToken;
  const stripeClient = {
    webhooks: signer.webhooks,
    checkout: {
      sessions: {
        create: async (params) => (
          (receiptToken = new URLSearchParams(
            new URL(params.success_url).hash.slice(9),
          ).get("token")),
          {
            id: "cs_test_session",
            url: "https://checkout.stripe.com/test",
            metadata: params.metadata,
          }
        ),
      },
    },
  };
  const { app, request, downloads } = await fixture(t, {
    mode: "live",
    stripeClient,
    stripeWebhookSecret: secret,
    baseUrl: "https://example.com",
  });
  writeFileSync(join(downloads, "book.pdf"), "the paid book");
  assert.equal(
    (
      await request("/api/admin/products/the-art-of-starting", {
        method: "PUT",
        auth: true,
        data: { sample: false, downloadFile: "book.pdf" },
      })
    ).status,
    200,
  );
  const checkout = await request("/api/checkout", {
    method: "POST",
    data: {
      email: "buyer@example.com",
      items: [{ productId: "the-art-of-starting", quantity: 1 }],
    },
  });
  assert.equal(checkout.status, 201);
  assert.equal(checkout.body.url, "https://checkout.stripe.com/test");
  const order = app.locals.store.db
    .prepare("SELECT * FROM orders LIMIT 1")
    .get();
  assert.equal(
    (await request(`/api/orders/${order.id}`, { auth: "wrong" })).status,
    404,
  );
  let receipt = await request(`/api/orders/${order.id}`, {
    auth: receiptToken,
  });
  assert.equal(receipt.body.status, "pending");
  assert.equal(receipt.body.items[0].downloadUrl, undefined);
  const event = {
    id: "evt_test",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_test_session",
        payment_intent: "pi_test_session",
        metadata: { orderId: order.id },
        payment_status: "paid",
        amount_total: 2400,
        currency: "usd",
      },
    },
  };
  const payload = JSON.stringify(event);
  assert.equal(
    (
      await request("/api/webhooks/stripe", {
        method: "POST",
        body: payload,
        headers: {
          "Content-Type": "application/json",
          "stripe-signature": "invalid",
        },
      })
    ).status,
    400,
  );
  assert.equal(app.locals.store.order(order.id).status, "pending");
  const signature = signer.webhooks.generateTestHeaderString({
    payload,
    secret,
  });
  const verified = await request("/api/webhooks/stripe", {
    method: "POST",
    body: payload,
    headers: {
      "Content-Type": "application/json",
      "stripe-signature": signature,
    },
  });
  assert.equal(verified.status, 200);
  receipt = await request(`/api/orders/${order.id}`, { auth: receiptToken });
  assert.equal(receipt.body.status, "paid");
  assert.equal("downloadFile" in receipt.body.items[0], false);
  assert.ok(receipt.body.items[0].downloadUrl);
  const download = await request(receipt.body.items[0].downloadUrl);
  assert.equal(download.status, 200);
  assert.equal(download.body, "the paid book");
  assert.equal(
    (
      await request(
        receipt.body.items[0].downloadUrl.replace(
          /signature=.*/,
          "signature=wrong",
        ),
      )
    ).status,
    403,
  );
  // Stripe retries are idempotent: the original paid order remains a single sale.
  assert.equal(
    (
      await request("/api/webhooks/stripe", {
        method: "POST",
        body: payload,
        headers: {
          "Content-Type": "application/json",
          "stripe-signature": signature,
        },
      })
    ).status,
    200,
  );
  assert.equal(
    (await request("/api/admin/overview", { auth: true })).body.stats
      .paidOrders,
    1,
  );
});

test("a mismatched paid amount never unlocks an order", async (t) => {
  const secret = "whsec_amount_test";
  const signer = new Stripe("sk_test_fake");
  const stripeClient = {
    webhooks: signer.webhooks,
    checkout: {
      sessions: {
        create: async () => ({
          id: "cs_amount_session",
          url: "https://checkout.stripe.com/test",
        }),
      },
    },
  };
  const { app, request, downloads } = await fixture(t, {
    mode: "live",
    stripeClient,
    stripeWebhookSecret: secret,
    baseUrl: "https://example.com",
  });
  writeFileSync(join(downloads, "book.pdf"), "book");
  await request("/api/admin/products/the-art-of-starting", {
    method: "PUT",
    auth: true,
    data: { sample: false, downloadFile: "book.pdf" },
  });
  await request("/api/checkout", {
    method: "POST",
    data: {
      email: "buyer@example.com",
      items: [{ productId: "the-art-of-starting", quantity: 1 }],
    },
  });
  const order = app.locals.store.db
    .prepare("SELECT * FROM orders LIMIT 1")
    .get();
  const payload = JSON.stringify({
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_amount_session",
        payment_intent: "pi_amount_session",
        metadata: { orderId: order.id },
        payment_status: "paid",
        amount_total: 1,
        currency: "usd",
      },
    },
  });
  const signature = signer.webhooks.generateTestHeaderString({
    payload,
    secret,
  });
  assert.equal(
    (
      await request("/api/webhooks/stripe", {
        method: "POST",
        body: payload,
        headers: {
          "Content-Type": "application/json",
          "stripe-signature": signature,
        },
      })
    ).status,
    400,
  );
  assert.equal(app.locals.store.order(order.id).status, "pending");
});
