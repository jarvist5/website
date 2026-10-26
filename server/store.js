import { DatabaseSync } from "node:sqlite";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";

export const hashReceiptToken = (token) =>
  `sha256:${createHash("sha256").update(token).digest("hex")}`;

const seed = JSON.parse(
  readFileSync(new URL("./seed.json", import.meta.url), "utf8"),
);

export function createStore(dbPath) {
  if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS products (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS subscribers (email TEXT PRIMARY KEY, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY, token TEXT NOT NULL, email TEXT NOT NULL,
      status TEXT NOT NULL, total INTEGER NOT NULL, currency TEXT NOT NULL,
      items TEXT NOT NULL, stripe_session TEXT UNIQUE, created_at TEXT NOT NULL,
      payment_intent TEXT
    );
    CREATE TABLE IF NOT EXISTS payment_revocations (
      payment_intent TEXT PRIMARY KEY, reason TEXT NOT NULL, created_at TEXT NOT NULL
    );
  `);
  // Preserve existing customer/order data while upgrading previously created stores.
  if (
    !db
      .prepare("PRAGMA table_info(orders)")
      .all()
      .some((column) => column.name === "payment_intent")
  ) {
    db.exec("ALTER TABLE orders ADD COLUMN payment_intent TEXT");
  }
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS orders_payment_intent ON orders(payment_intent) WHERE payment_intent IS NOT NULL",
  );
  const legacyTokens = db
    .prepare("SELECT id,token FROM orders WHERE token NOT LIKE 'sha256:%'")
    .all();
  if (legacyTokens.length) {
    db.exec("BEGIN");
    try {
      const migrate = db.prepare("UPDATE orders SET token=? WHERE id=?");
      for (const order of legacyTokens)
        migrate.run(hashReceiptToken(order.token), order.id);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  if (
    !db.prepare("SELECT value FROM metadata WHERE key='catalog_seeded'").get()
  ) {
    db.exec("BEGIN");
    try {
      const insert = db.prepare(
        "INSERT OR IGNORE INTO products (id,data) VALUES (?,?)",
      );
      for (const p of seed) insert.run(p.id, JSON.stringify(p));
      db.prepare(
        "INSERT INTO metadata(key,value) VALUES ('catalog_seeded','true')",
      ).run();
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  return {
    db,
    products: () =>
      db
        .prepare("SELECT data FROM products ORDER BY rowid")
        .all()
        .map((p) => JSON.parse(p.data)),
    product: (id) => {
      const row = db.prepare("SELECT data FROM products WHERE id=?").get(id);
      return row ? JSON.parse(row.data) : null;
    },
    saveProduct(product) {
      db.prepare("UPDATE products SET data=? WHERE id=?").run(
        JSON.stringify(product),
        product.id,
      );
    },
    addProduct(product) {
      db.prepare("INSERT INTO products(id,data) VALUES (?,?)").run(
        product.id,
        JSON.stringify(product),
      );
    },
    deleteProduct(id) {
      db.prepare("DELETE FROM products WHERE id=?").run(id);
    },
    subscribe(email) {
      return db
        .prepare(
          "INSERT OR IGNORE INTO subscribers(email,created_at) VALUES (?,?)",
        )
        .run(email, new Date().toISOString());
    },
    order: (id) => db.prepare("SELECT * FROM orders WHERE id=?").get(id),
    saveOrder(order) {
      db.prepare(
        `INSERT INTO orders(id,token,email,status,total,currency,items,created_at) VALUES (?,?,?,?,?,?,?,?)`,
      ).run(
        order.id,
        hashReceiptToken(order.token),
        order.email,
        order.status,
        order.total,
        order.currency,
        JSON.stringify(order.items),
        new Date().toISOString(),
      );
    },
    setSession(id, session) {
      db.prepare("UPDATE orders SET stripe_session=? WHERE id=?").run(
        session,
        id,
      );
    },
    markPaid(id, session, amount, currency, paymentIntent) {
      const row = db
        .prepare("SELECT * FROM orders WHERE id=? AND stripe_session=?")
        .get(id, session);
      if (
        !row ||
        row.total !== amount ||
        row.currency !== currency ||
        !["pending", "paid", "refunded", "disputed"].includes(row.status) ||
        (paymentIntent &&
          row.payment_intent &&
          row.payment_intent !== paymentIntent)
      )
        return false;
      if (paymentIntent) {
        const other = db
          .prepare("SELECT id FROM orders WHERE payment_intent=? AND id<>?")
          .get(paymentIntent, id);
        if (other) return false;
      }
      const revoked =
        paymentIntent &&
        db
          .prepare(
            "SELECT reason FROM payment_revocations WHERE payment_intent=?",
          )
          .get(paymentIntent);
      // A late or repeated success event must never reverse a refund/dispute hold.
      const status =
        revoked?.reason ??
        (["refunded", "disputed"].includes(row.status) ? row.status : "paid");
      db.prepare(
        "UPDATE orders SET status=?,payment_intent=coalesce(payment_intent,?) WHERE id=?",
      ).run(status, paymentIntent ?? null, id);
      return true;
    },
    revokeByPaymentIntent(paymentIntent, reason) {
      if (!["refunded", "disputed"].includes(reason))
        throw new Error("Invalid revocation reason");
      db.exec("BEGIN");
      try {
        db.prepare(
          "INSERT INTO payment_revocations(payment_intent,reason,created_at) VALUES (?,?,?) ON CONFLICT(payment_intent) DO UPDATE SET reason=excluded.reason",
        ).run(paymentIntent, reason, new Date().toISOString());
        db.prepare("UPDATE orders SET status=? WHERE payment_intent=?").run(
          reason,
          paymentIntent,
        );
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    deletePending(id) {
      db.prepare(
        "DELETE FROM orders WHERE id=? AND status='pending' AND stripe_session IS NULL",
      ).run(id);
    },
    overview() {
      const count = (status) =>
        Number(
          db
            .prepare("SELECT count(*) AS count FROM orders WHERE status=?")
            .get(status).count,
        );
      return {
        stats: {
          products: Number(
            db.prepare("SELECT count(*) AS count FROM products").get().count,
          ),
          subscribers: Number(
            db.prepare("SELECT count(*) AS count FROM subscribers").get().count,
          ),
          previewOrders: count("preview"),
          paidOrders: count("paid"),
          revenue: Number(
            db
              .prepare(
                "SELECT coalesce(sum(total),0) AS total FROM orders WHERE status='paid'",
              )
              .get().total,
          ),
        },
        orders: db
          .prepare(
            "SELECT id,email,status,total,currency,created_at FROM orders ORDER BY created_at DESC LIMIT 50",
          )
          .all(),
        subscribers: db
          .prepare(
            "SELECT email,created_at FROM subscribers ORDER BY created_at DESC LIMIT 50",
          )
          .all(),
      };
    },
    close() {
      db.close();
    },
  };
}
