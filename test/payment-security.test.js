import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createStore, hashReceiptToken } from "../server/store.js";
import { handlePaymentEvent } from "../server/payment-events.js";
import { createApp } from "../server/index.js";
import Stripe from "stripe";

function fixture(t) {
  const store = createStore(":memory:");
  t.after(() => store.close());
  store.saveOrder({
    id: "order-one",
    token: "raw-private-receipt-token",
    email: "test@example.com",
    status: "pending",
    total: 2400,
    currency: "usd",
    items: [{ productId: "book", price: 2400, quantity: 1 }],
  });
  store.setSession("order-one", "cs_test_one");
  return store;
}
const completed = (overrides = {}) => ({
  type: "checkout.session.completed",
  data: {
    object: {
      id: "cs_test_one",
      metadata: { orderId: "order-one" },
      amount_total: 2400,
      currency: "usd",
      payment_status: "paid",
      payment_intent: "pi_test_one",
      ...overrides,
    },
  },
});
const refund = (overrides = {}) => ({
  type: "charge.refunded",
  data: {
    object: {
      id: "ch_test_one",
      payment_intent: "pi_test_one",
      refunded: true,
      amount: 2400,
      amount_refunded: 2400,
      ...overrides,
    },
  },
});
const dispute = (overrides = {}) => ({
  type: "charge.dispute.created",
  data: {
    object: { id: "dp_test_one", payment_intent: "pi_test_one", ...overrides },
  },
});

test("receipt credentials are hashed before database persistence", (t) => {
  const store = fixture(t);
  assert.equal(
    store.order("order-one").token,
    hashReceiptToken("raw-private-receipt-token"),
  );
  assert.notEqual(store.order("order-one").token, "raw-private-receipt-token");
});
test("verified matched completion associates the payment intent idempotently", (t) => {
  const store = fixture(t);
  assert.deepEqual(handlePaymentEvent(store, completed()), {
    handled: true,
    matched: true,
  });
  assert.equal(store.order("order-one").status, "paid");
  assert.equal(store.order("order-one").payment_intent, "pi_test_one");
  assert.equal(handlePaymentEvent(store, completed()).matched, true);
  assert.equal(store.overview().stats.paidOrders, 1);
});
test("mismatched or missing payment identities do not grant access", (t) => {
  const store = fixture(t);
  for (const fields of [
    { payment_intent: null },
    { amount_total: 1 },
    { currency: "eur" },
    { id: "cs_another" },
  ]) {
    assert.equal(handlePaymentEvent(store, completed(fields)).matched, false);
    assert.equal(store.order("order-one").status, "pending");
  }
  handlePaymentEvent(store, completed());
  assert.equal(
    handlePaymentEvent(store, completed({ payment_intent: "pi_different" }))
      .matched,
    false,
  );
});
test("a full refund removes entitlement and repeated success events never restore it", (t) => {
  const store = fixture(t);
  handlePaymentEvent(store, completed());
  assert.equal(handlePaymentEvent(store, refund()).matched, true);
  assert.equal(store.order("order-one").status, "refunded");
  assert.equal(store.overview().stats.revenue, 0);
  handlePaymentEvent(store, completed());
  assert.equal(store.order("order-one").status, "refunded");
  handlePaymentEvent(store, refund());
  assert.equal(store.order("order-one").status, "refunded");
});
test("a dispute places a permanent entitlement hold until manual reconciliation", (t) => {
  const store = fixture(t);
  handlePaymentEvent(store, completed());
  handlePaymentEvent(store, dispute());
  assert.equal(store.order("order-one").status, "disputed");
  handlePaymentEvent(store, completed());
  assert.equal(store.order("order-one").status, "disputed");
  assert.equal(store.overview().stats.paidOrders, 0);
});
test("refunds and disputes arriving before completion are retained and fail closed", (t) => {
  for (const event of [refund(), dispute()]) {
    const store = createStore(":memory:");
    t.after(() => store.close());
    handlePaymentEvent(store, event);
    store.saveOrder({
      id: "order-one",
      token: "token",
      email: "test@example.com",
      status: "pending",
      total: 2400,
      currency: "usd",
      items: [],
    });
    store.setSession("order-one", "cs_test_one");
    assert.equal(handlePaymentEvent(store, completed()).matched, true);
    assert.equal(
      store.order("order-one").status,
      event.type === "charge.refunded" ? "refunded" : "disputed",
    );
  }
});
test("partial refunds leave full-order entitlement unchanged and invalid revocations are rejected", (t) => {
  const store = fixture(t);
  handlePaymentEvent(store, completed());
  assert.deepEqual(
    handlePaymentEvent(
      store,
      refund({ refunded: false, amount_refunded: 100 }),
    ),
    { handled: false, matched: true },
  );
  assert.equal(store.order("order-one").status, "paid");
  assert.equal(
    handlePaymentEvent(store, refund({ payment_intent: null })).matched,
    false,
  );
  assert.equal(
    handlePaymentEvent(store, dispute({ payment_intent: "not-an-intent" }))
      .matched,
    false,
  );
  assert.equal(store.order("order-one").status, "paid");
});
test("unknown and unpaid payment events never change entitlement", (t) => {
  const store = fixture(t);
  for (const event of [
    null,
    { type: "unhandled" },
    completed({ payment_status: "unpaid" }),
  ]) {
    assert.deepEqual(handlePaymentEvent(store, event), {
      handled: false,
      matched: true,
    });
    assert.equal(store.order("order-one").status, "pending");
  }
});
test("a payment intent cannot fund multiple distinct orders", (t) => {
  const store = fixture(t);
  handlePaymentEvent(store, completed());
  store.saveOrder({
    id: "order-two",
    token: "other-token",
    email: "other@example.com",
    status: "pending",
    total: 2400,
    currency: "usd",
    items: [],
  });
  store.setSession("order-two", "cs_test_two");
  assert.equal(
    handlePaymentEvent(
      store,
      completed({ id: "cs_test_two", metadata: { orderId: "order-two" } }),
    ).matched,
    false,
  );
  assert.equal(store.order("order-two").status, "pending");
});
test("legacy order migration hashes credentials and preserves existing rows across restarts", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "leafivo-payment-migrate-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "store.sqlite");
  const old = new DatabaseSync(path);
  old.exec(
    "CREATE TABLE orders(id TEXT PRIMARY KEY, token TEXT NOT NULL, email TEXT NOT NULL,status TEXT NOT NULL,total INTEGER NOT NULL,currency TEXT NOT NULL,items TEXT NOT NULL,stripe_session TEXT UNIQUE,created_at TEXT NOT NULL)",
  );
  old
    .prepare("INSERT INTO orders VALUES (?,?,?,?,?,?,?,?,?)")
    .run(
      "old-order",
      "legacy-private-token",
      "buyer@example.com",
      "paid",
      2400,
      "usd",
      "[]",
      "cs_old",
      new Date().toISOString(),
    );
  old.close();
  let store = createStore(path);
  assert.equal(
    store.order("old-order").token,
    hashReceiptToken("legacy-private-token"),
  );
  assert.equal(store.order("old-order").status, "paid");
  assert.equal(store.order("old-order").payment_intent, null);
  store.revokeByPaymentIntent("pi_precompletion", "refunded");
  store.close();
  store = createStore(path);
  assert.equal(
    store.order("old-order").token,
    hashReceiptToken("legacy-private-token"),
  );
  assert.equal(
    store.db
      .prepare("SELECT reason FROM payment_revocations WHERE payment_intent=?")
      .get("pi_precompletion").reason,
    "refunded",
  );
  store.close();
});

for (const [name, revokedEvent, expected] of [
  ["full refund", refund(), "refunded"],
  ["dispute", dispute(), "disputed"],
]) {
  test(`signed ${name} event blocks existing and newly requested download links`, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "leafivo-paid-revoke-"));
    const secret = "whsec_isolated_test_only";
    const signer = new Stripe("sk_test_isolated_fake");
    writeFileSync(join(dir, "book.pdf"), "owned educational test file");
    const app = createApp({
      dbPath: ":memory:",
      adminToken: "isolated-test-admin-secret-32-characters",
      mode: "live",
      stripeClient: { webhooks: signer.webhooks },
      stripeWebhookSecret: secret,
      baseUrl: "https://store.example.com",
      downloadDir: dir,
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    t.after(async () => {
      await new Promise((resolve) => server.close(resolve));
      app.locals.close();
      rmSync(dir, { recursive: true, force: true });
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const token = "private-receipt-token-only-for-this-test";
    app.locals.store.saveOrder({
      id: "order-one",
      token,
      email: "buyer@example.com",
      status: "pending",
      total: 2400,
      currency: "usd",
      items: [
        {
          productId: "book",
          title: "Book",
          price: 2400,
          quantity: 1,
          downloadFile: "book.pdf",
        },
      ],
    });
    app.locals.store.setSession("order-one", "cs_test_one");
    const sendEvent = async (event) => {
      const payload = JSON.stringify(event);
      return fetch(`${base}/api/webhooks/stripe`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "stripe-signature": signer.webhooks.generateTestHeaderString({
            payload,
            secret,
          }),
        },
        body: payload,
      });
    };
    const receipt = () =>
      fetch(`${base}/api/orders/order-one`, {
        headers: { Authorization: `Bearer ${token}` },
      });
    assert.equal((await sendEvent(completed())).status, 200);
    const paid = await (await receipt()).json();
    assert.equal(paid.status, "paid");
    assert.equal((await fetch(base + paid.items[0].downloadUrl)).status, 200);
    assert.equal((await sendEvent(revokedEvent)).status, 200);
    assert.equal((await fetch(base + paid.items[0].downloadUrl)).status, 404);
    const revoked = await (await receipt()).json();
    assert.equal(revoked.status, expected);
    assert.equal(revoked.items[0].downloadUrl, undefined);
    assert.equal((await sendEvent(completed())).status, 200);
    assert.equal((await fetch(base + paid.items[0].downloadUrl)).status, 404);
  });
}

test("receipt bearer access expires after 24 hours and query tokens are rejected", async (t) => {
  const app = createApp({ dbPath: ":memory:", mode: "preview" });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    app.locals.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  app.locals.store.saveOrder({
    id: "expiring",
    token: "private-test-token",
    email: "test@example.com",
    status: "preview",
    total: 100,
    currency: "usd",
    items: [],
  });
  assert.equal(
    (await fetch(`${base}/api/orders/expiring?token=private-test-token`))
      .status,
    404,
  );
  assert.equal(
    (
      await fetch(`${base}/api/orders/expiring`, {
        headers: { Authorization: "Bearer private-test-token" },
      })
    ).status,
    200,
  );
  app.locals.store.db
    .prepare("UPDATE orders SET created_at=? WHERE id=?")
    .run(new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(), "expiring");
  assert.equal(
    (
      await fetch(`${base}/api/orders/expiring`, {
        headers: { Authorization: "Bearer private-test-token" },
      })
    ).status,
    404,
  );
});
