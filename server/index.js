import "dotenv/config";
import express from "express";
import Stripe from "stripe";
import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, resolve, relative, isAbsolute, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { createStore, hashReceiptToken } from "./store.js";
import {
  securityHeaders,
  protectBrowserMutations,
  denyPrivatePaths,
  publicOrigin,
  assertPrivateStoragePaths,
} from "./security.js";
import { handlePaymentEvent } from "./payment-events.js";
import { createOwnerAuth } from "./owner-auth.js";
import { createProductFileHandler } from "./product-files.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const allowedCovers = ["sage", "peach", "blue", "yellow", "pink", "ink"];
const allowedCategories = ["Ebooks", "Templates", "Bundles"];
const publicProduct = ({ downloadFile, ...product }) => ({
  ...product,
  downloadReady: Boolean(downloadFile),
});
const secureEqual = (a, b) => {
  if (typeof a !== "string" || typeof b !== "string") return false;
  return timingSafeEqual(
    createHash("sha256").update(a).digest(),
    createHash("sha256").update(b).digest(),
  );
};

export function createApp(options = {}) {
  const production =
    options.production ?? process.env.NODE_ENV === "production";
  const ownerEnabled =
    options.ownerManagementEnabled ??
    process.env.OWNER_MANAGEMENT_ENABLED === "true";
  const ownerStoragePersistent =
    options.ownerStoragePersistent ??
    process.env.OWNER_STORAGE_PERSISTENT === "true";
  if (ownerEnabled && production && !ownerStoragePersistent)
    throw new Error(
      "Production owner access requires verified permanent storage.",
    );
  const mode = options.mode ?? process.env.STORE_MODE ?? "preview";
  const publicPreview =
    options.publicPreview ?? process.env.PUBLIC_PREVIEW === "true";
  if (publicPreview && mode !== "preview")
    throw new Error("PUBLIC_PREVIEW requires STORE_MODE=preview.");
  const adminToken = options.adminToken ?? process.env.ADMIN_TOKEN ?? "";
  const stripeSecretKey =
    options.stripeSecretKey ?? process.env.STRIPE_SECRET_KEY ?? "";
  const webhookSecret =
    options.stripeWebhookSecret ?? process.env.STRIPE_WEBHOOK_SECRET ?? "";
  const baseUrl = (
    options.baseUrl ??
    (process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || "")
  ).replace(/\/$/, "");
  const downloadDir = resolve(
    options.downloadDir ??
      (process.env.DOWNLOAD_DIR ||
        process.env.DOWNLOADS_DIR ||
        resolve(root, "private-downloads")),
  );
  const dbPath =
    options.dbPath ??
    (process.env.DATABASE_PATH ||
      resolve(process.env.DATA_DIR || resolve(root, ".data"), "store.sqlite"));
  assertPrivateStoragePaths({
    dbPath,
    downloadDir,
    publicDirs: [resolve(root, "dist"), resolve(root, "public")],
  });
  const store = createStore(dbPath);
  const stripe =
    options.stripeClient ??
    (stripeSecretKey
      ? new Stripe(stripeSecretKey, { timeout: 20000, maxNetworkRetries: 1 })
      : null);
  const app = express();
  const origin = publicOrigin(baseUrl);
  const downloadSigningKey =
    options.downloadSigningKey ??
    process.env.DOWNLOAD_SIGNING_KEY ??
    adminToken;
  const ownerAuth = ownerEnabled
    ? createOwnerAuth({
        db: store.db,
        production,
        origin: origin || "",
        setupToken:
          options.ownerSetupToken ?? process.env.OWNER_SETUP_TOKEN ?? "",
        setupExpires:
          options.ownerSetupExpires ?? process.env.OWNER_SETUP_EXPIRES ?? "",
        sessionKey: options.ownerAuthKey ?? process.env.OWNER_AUTH_KEY ?? "",
      })
    : null;
  if (ownerEnabled)
    store.db
      .prepare(
        "INSERT OR IGNORE INTO metadata(key,value) VALUES('owner_storage_identity',?)",
      )
      .run(randomUUID());
  const storageIdentity = ownerEnabled
    ? store.db
        .prepare(
          "SELECT value FROM metadata WHERE key='owner_storage_identity'",
        )
        .get().value
    : undefined;
  app.disable("x-powered-by");
  const proxyHops = Number(
    options.trustProxyHops ?? process.env.TRUST_PROXY_HOPS ?? 0,
  );
  if (Number.isInteger(proxyHops) && proxyHops >= 1 && proxyHops <= 3)
    app.set("trust proxy", proxyHops);
  app.locals.store = store;
  app.locals.close = () => store.close();
  const liveConfigured =
    mode === "live" &&
    Boolean(
      stripe &&
      webhookSecret &&
      (production
        ? ownerAuth?.status().configured && downloadSigningKey.length >= 32
        : adminToken.length >= 24) &&
      origin &&
      origin.startsWith("https://"),
    );
  const limits = new Map();
  const limited =
    (scope, max, windowMs = 15 * 60 * 1000) =>
    (req, res, next) => {
      const now = Date.now();
      if (limits.size > 5000)
        for (const [key, record] of limits)
          if (record.until < now) limits.delete(key);
      const key = `${scope}:${req.ip}`;
      if (!limits.has(key) && limits.size >= 10000)
        return res
          .set("Retry-After", "60")
          .status(503)
          .json({ error: "The store is busy. Please try again shortly." });
      let value = limits.get(key);
      if (!value || value.until < now)
        value = { count: 0, until: now + windowMs };
      limits.set(key, value);
      if (++value.count > max)
        return res
          .set(
            "Retry-After",
            String(Math.max(1, Math.ceil((value.until - now) / 1000))),
          )
          .status(429)
          .json({ error: "Too many requests. Please try again later." });
      next();
    };
  const admin = (req, res, next) => {
    if (ownerAuth) return ownerAuth.middleware.requireOwner(req, res, next);
    if (publicPreview)
      return res.status(403).json({
        error: "Owner management is disabled in this public preview.",
      });
    if (production)
      return res
        .status(503)
        .json({
          error: "Secure owner sign-in is required for store management.",
        });
    if (!adminToken || adminToken.length < 24)
      return res.status(503).json({
        error:
          "Store management is not configured. Set a secure ADMIN_TOKEN of at least 24 characters on the server.",
      });
    const supplied = (req.headers.authorization ?? "").startsWith("Bearer ")
      ? req.headers.authorization.slice(7)
      : "";
    if (!secureEqual(supplied, adminToken))
      return res
        .status(401)
        .json({ error: "A valid store management token is required." });
    res.set("Cache-Control", "no-store");
    next();
  };
  const privateFile = (filename) => {
    if (
      typeof filename !== "string" ||
      !filename ||
      isAbsolute(filename) ||
      filename.includes("\0")
    )
      return null;
    const full = resolve(downloadDir, filename);
    const rel = relative(downloadDir, full);
    if (rel.startsWith("..") || isAbsolute(rel) || !existsSync(full))
      return null;
    const realDir = realpathSync(downloadDir);
    const realFile = realpathSync(full);
    const realRel = relative(realDir, realFile);
    if (
      realRel.startsWith("..") ||
      isAbsolute(realRel) ||
      !statSync(realFile).isFile()
    )
      return null;
    return realFile;
  };
  const downloadSignature = (orderId, productId, expiry) =>
    createHmac("sha256", downloadSigningKey)
      .update(`${orderId}:${productId}:${expiry}`)
      .digest("hex");
  const productFields = new Set([
    "title",
    "subtitle",
    "description",
    "category",
    "price",
    "details",
    "pages",
    "format",
    "cover",
    "featured",
    "sample",
    "downloadFile",
  ]);
  const validateProduct = (product) => {
    const text = (value, min, max) =>
      typeof value === "string" &&
      value.trim().length >= min &&
      value.length <= max;
    if (
      !text(product.title, 1, 120) ||
      !text(product.subtitle, 0, 160) ||
      !text(product.description, 1, 4000) ||
      !text(product.format, 1, 100) ||
      !allowedCategories.includes(product.category) ||
      !allowedCovers.includes(product.cover) ||
      !Number.isInteger(product.price) ||
      product.price < 50 ||
      product.price > 9999999 ||
      !Number.isInteger(product.pages) ||
      product.pages < 1 ||
      product.pages > 100000 ||
      typeof product.featured !== "boolean" ||
      typeof product.sample !== "boolean" ||
      !Array.isArray(product.details) ||
      product.details.length > 12 ||
      product.details.some((v) => !text(v, 1, 300))
    )
      return "Check product fields. Price must be in cents, with valid text, category, cover, and page count.";
    if (product.downloadFile && !privateFile(product.downloadFile))
      return "The product file must already exist inside the private downloads directory.";
    if (!product.sample && !privateFile(product.downloadFile))
      return "Add a real product file before removing the sample label.";
    return null;
  };

  app.use(securityHeaders(production));
  if (publicPreview)
    app.use((req, res, next) => {
      res.set("X-Robots-Tag", "noindex, nofollow");
      next();
    });
  app.use(denyPrivatePaths);
  app.use(protectBrowserMutations(origin));

  // Stripe requires the exact unparsed body to verify its signature.
  app.post(
    "/api/webhooks/stripe",
    express.raw({ type: "application/json", limit: "1mb" }),
    async (req, res) => {
      if (!stripe || !webhookSecret || mode !== "live")
        return res.status(503).json({ error: "Payments are not configured." });
      let event;
      try {
        event = stripe.webhooks.constructEvent(
          req.body,
          req.headers["stripe-signature"],
          webhookSecret,
        );
      } catch {
        return res.status(400).json({ error: "Invalid payment signature." });
      }
      const result = handlePaymentEvent(store, event);
      if (!result.matched)
        return res
          .status(400)
          .json({ error: "Payment does not match an existing order." });
      res.json({ received: true });
    },
  );
  app.use(express.json({ limit: "24kb" }));
  if (ownerAuth) app.use("/api/owner", ownerAuth.router);
  else {
    app.get("/api/owner/session", (req, res) =>
      res.json({
        authenticated: false,
        configured: false,
        setupAvailable: false,
        enabled: false,
      }),
    );
    app.use("/api/owner", (req, res) =>
      res.status(503).json({ error: "Owner access is not enabled yet." }),
    );
  }
  app.put(
    "/api/admin/products/:id/file",
    limited("admin", 60),
    admin,
    express.raw({
      type: [
        "application/pdf",
        "application/epub+zip",
        "application/zip",
        "application/octet-stream",
      ],
      limit: "25mb",
    }),
    createProductFileHandler({ store, downloadDir }),
  );
  app.get(
    "/api/admin/products/:id/file",
    limited("admin", 60),
    admin,
    (req, res) => {
      const product = store.product(req.params.id);
      const file = product && privateFile(product.downloadFile);
      if (!file)
        return res
          .status(404)
          .json({ error: "No private file is available for this product." });
      res.download(file, `${product.id}${extname(file)}`);
    },
  );

  app.get("/api/health", (req, res) =>
    res.json({
      status: "ok",
      mode,
      publicPreview,
      ownerAccess: ownerEnabled,
      ...(req.path === "/api/health"
        ? { storagePersistent: ownerStoragePersistent, storageIdentity }
        : {}),
      checkoutEnabled: mode === "preview" || liveConfigured,
    }),
  );
  app.get("/api/store", (req, res) =>
    res.json({
      name: options.storeName ?? process.env.STORE_NAME ?? "Leafivo",
      currency: "usd",
      mode,
      publicPreview,
      ownerAccess: ownerEnabled,
      ...(req.path === "/api/health"
        ? { storagePersistent: ownerStoragePersistent, storageIdentity }
        : {}),
      checkoutEnabled: mode === "preview" || liveConfigured,
      products: store.products().map(publicProduct),
    }),
  );
  app.get("/api/products/:id", (req, res) => {
    const product = store.product(req.params.id);
    if (!product) return res.status(404).json({ error: "Product not found." });
    res.json(publicProduct(product));
  });
  app.post("/api/newsletter", limited("newsletter", 10), (req, res) => {
    if (publicPreview)
      return res.status(503).json({
        error:
          "Email signup is not available in this public preview. No email address has been saved.",
      });
    const email =
      typeof req.body?.email === "string"
        ? req.body.email.trim().toLowerCase()
        : "";
    if (email.length > 254 || !emailPattern.test(email))
      return res.status(400).json({ error: "Enter a valid email address." });
    if (req.body?.consent !== true)
      return res.status(400).json({
        error: "Please agree to receive store emails before subscribing.",
      });
    store.subscribe(email);
    res.status(201).json({
      message:
        "You’re on the list. Your email has been saved; email delivery will begin when the store connects its email service.",
    });
  });
  app.post("/api/checkout", limited("checkout", 30), async (req, res, next) => {
    try {
      if (!["preview", "live"].includes(mode))
        return res
          .status(503)
          .json({ error: "The store is not configured for checkout." });
      if (mode === "live" && !liveConfigured)
        return res.status(503).json({
          error: "Live checkout is not configured yet. Please check back soon.",
        });
      const email =
        !publicPreview && typeof req.body?.email === "string"
          ? req.body.email.trim().toLowerCase()
          : "";
      if (!publicPreview && (email.length > 254 || !emailPattern.test(email)))
        return res.status(400).json({ error: "Enter a valid email address." });
      if (
        !Array.isArray(req.body?.items) ||
        req.body.items.length < 1 ||
        req.body.items.length > 20
      )
        return res
          .status(400)
          .json({ error: "Your bag must contain between 1 and 20 products." });
      const seen = new Set();
      const items = [];
      for (const item of req.body.items) {
        if (
          !item ||
          typeof item.productId !== "string" ||
          !Number.isInteger(item.quantity) ||
          item.quantity < 1 ||
          item.quantity > 10 ||
          seen.has(item.productId)
        )
          return res
            .status(400)
            .json({ error: "Invalid product quantity or duplicate product." });
        const product = store.product(item.productId);
        if (!product)
          return res
            .status(400)
            .json({ error: "A product in your bag is no longer available." });
        if (
          mode === "live" &&
          (product.sample || !privateFile(product.downloadFile))
        )
          return res.status(409).json({
            error:
              "Sample products cannot be purchased. The store owner must add the real product file before enabling sales.",
          });
        seen.add(product.id);
        items.push({
          productId: product.id,
          title: product.title,
          price: product.price,
          quantity: item.quantity,
          ...(product.downloadFile
            ? { downloadFile: product.downloadFile }
            : {}),
        });
      }
      const total = items.reduce(
        (sum, item) => sum + item.price * item.quantity,
        0,
      );
      if (!Number.isSafeInteger(total) || total < 50 || total > 99999999)
        return res
          .status(400)
          .json({ error: "Order total is outside the supported range." });
      const order = {
        id: randomUUID(),
        token: randomBytes(32).toString("hex"),
        email,
        status: mode === "preview" ? "preview" : "pending",
        total,
        currency: "usd",
        items,
      };
      if (!publicPreview) store.saveOrder(order);
      const publicItems = items.map(({ downloadFile, ...item }) => item);
      if (mode === "preview")
        return res.status(201).json({
          mode: "preview",
          persisted: !publicPreview,
          order: {
            id: order.id,
            total,
            currency: "usd",
            status: "preview",
            items: publicItems,
          },
          message: publicPreview
            ? "Practice checkout complete. No payment was taken, no order or email was saved, and no product has been delivered."
            : "Preview order recorded. No payment was taken and no product has been delivered.",
        });
      try {
        const session = await stripe.checkout.sessions.create(
          {
            mode: "payment",
            customer_email: email,
            line_items: items.map((item) => ({
              quantity: item.quantity,
              price_data: {
                currency: "usd",
                unit_amount: item.price,
                product_data: { name: item.title },
              },
            })),
            metadata: { orderId: order.id },
            success_url: `${origin}/?checkout=success#receipt?order=${encodeURIComponent(order.id)}&token=${order.token}`,
            cancel_url: `${origin}/?checkout=cancelled`,
          },
          { idempotencyKey: order.id },
        );
        const checkoutUrl = new URL(session.url);
        if (checkoutUrl.origin !== "https://checkout.stripe.com")
          throw new Error("Unexpected checkout destination");
        store.setSession(order.id, session.id);
        res.status(201).json({ mode: "live", url: session.url });
      } catch (error) {
        store.deletePending(order.id);
        res.status(502).json({
          error:
            "The payment service is temporarily unavailable. No payment has been recorded by this store. Please try again.",
        });
      }
    } catch (error) {
      next(error);
    }
  });
  app.get("/api/orders/:id", limited("orders", 60), (req, res) => {
    if (publicPreview)
      return res.status(404).json({ error: "Order not found." });
    const order = store.order(req.params.id);
    const supplied = (req.headers.authorization ?? "").startsWith("Bearer ")
      ? req.headers.authorization.slice(7)
      : "";
    const tokenHash = hashReceiptToken(supplied);
    const age = order ? Date.now() - Date.parse(order.created_at) : Infinity;
    if (
      !order ||
      !supplied ||
      !secureEqual(tokenHash, order.token) ||
      !Number.isFinite(age) ||
      age < 0 ||
      age > 24 * 60 * 60 * 1000
    )
      return res.status(404).json({ error: "Order not found." });
    const expiry = Date.now() + 60 * 60 * 1000;
    res.json({
      id: order.id,
      status: order.status,
      total: order.total,
      currency: order.currency,
      items: JSON.parse(order.items).map(({ downloadFile, ...item }) => ({
        ...item,
        ...(order.status === "paid" && downloadFile && privateFile(downloadFile)
          ? {
              downloadUrl: `/api/downloads/${order.id}/${item.productId}?expires=${expiry}&signature=${downloadSignature(order.id, item.productId, expiry)}`,
            }
          : {}),
      })),
    });
  });
  app.get(
    "/api/downloads/:orderId/:productId",
    limited("downloads", 60),
    (req, res) => {
      if (publicPreview)
        return res
          .status(404)
          .json({ error: "Download unavailable in this public preview." });
      const expiry = Number(req.query.expires);
      if (
        !downloadSigningKey ||
        !Number.isSafeInteger(expiry) ||
        expiry < Date.now() ||
        expiry > Date.now() + 60 * 60 * 1000 + 1000 ||
        !secureEqual(
          req.query.signature,
          downloadSignature(req.params.orderId, req.params.productId, expiry),
        )
      )
        return res
          .status(403)
          .json({ error: "This download link has expired or is invalid." });
      const order = store.order(req.params.orderId);
      const item =
        order?.status === "paid" &&
        JSON.parse(order.items).find(
          (p) => p.productId === req.params.productId,
        );
      const file = item && privateFile(item.downloadFile);
      if (!file)
        return res.status(404).json({
          error: "Download unavailable. Please contact the store owner.",
        });
      const name = `${item.productId}${extname(file)}`;
      res.download(file, name);
    },
  );
  app.get("/api/admin/overview", limited("admin", 60), admin, (req, res) => {
    res.json({
      ...store.overview(),
      products: store.products().map(publicProduct),
      mode,
      publicPreview,
      ownerAccess: ownerEnabled,
      ...(req.path === "/api/health"
        ? { storagePersistent: ownerStoragePersistent, storageIdentity }
        : {}),
      checkoutEnabled: mode === "preview" || liveConfigured,
    });
  });
  app.post("/api/admin/products", limited("admin", 60), admin, (req, res) => {
    if (
      !req.body ||
      Array.isArray(req.body) ||
      typeof req.body !== "object" ||
      Object.keys(req.body).some((key) => !productFields.has(key))
    )
      return res
        .status(400)
        .json({ error: "Provide supported product fields as an object." });
    const slug =
      typeof req.body.title === "string"
        ? req.body.title
            .toLowerCase()
            .normalize("NFKD")
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "")
            .slice(0, 80)
        : "";
    const product = {
      id: `${slug || "product"}-${randomBytes(4).toString("hex")}`,
      title: "",
      subtitle: "",
      description: "",
      category: "Ebooks",
      price: 1900,
      currency: "usd",
      details: [],
      pages: 1,
      format: "PDF ebook",
      cover: "sage",
      featured: false,
      sample: true,
      ...req.body,
    };
    const error = validateProduct(product);
    if (error) return res.status(400).json({ error });
    store.addProduct(product);
    res.status(201).json(publicProduct(product));
  });
  app.delete(
    "/api/admin/products/:id",
    limited("admin", 60),
    admin,
    (req, res) => {
      if (!store.product(req.params.id))
        return res.status(404).json({ error: "Product not found." });
      store.deleteProduct(req.params.id);
      res.json({
        deleted: true,
        message:
          "Listing removed. Existing orders and private product files are retained.",
      });
    },
  );
  app.put(
    "/api/admin/products/:id",
    limited("admin", 60),
    admin,
    (req, res) => {
      const current = store.product(req.params.id);
      if (!current)
        return res.status(404).json({ error: "Product not found." });
      if (!req.body || Array.isArray(req.body) || typeof req.body !== "object")
        return res
          .status(400)
          .json({ error: "Provide product fields as an object." });
      const product = { ...current };
      if (Object.keys(req.body).some((key) => !productFields.has(key)))
        return res
          .status(400)
          .json({ error: "The request contains unsupported product fields." });
      for (const [key, value] of Object.entries(req.body)) product[key] = value;
      const error = validateProduct(product);
      if (error) return res.status(400).json({ error });
      store.saveProduct(product);
      res.json(publicProduct(product));
    },
  );
  app.use("/api", (req, res) =>
    res.status(404).json({ error: "Endpoint not found." }),
  );
  if (existsSync(resolve(root, "dist/index.html"))) {
    app.use(
      express.static(resolve(root, "dist"), {
        index: false,
        setHeaders: (res, path) => {
          if (extname(path) === ".html") res.set("Cache-Control", "no-store");
        },
      }),
    );
    app.get("/{*path}", (req, res) =>
      res
        .set("Cache-Control", "no-store")
        .sendFile(resolve(root, "dist/index.html")),
    );
  }
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error.type === "entity.parse.failed")
      return res.status(400).json({ error: "Invalid JSON request." });
    if (error.type === "entity.too.large")
      return res.status(413).json({ error: "Request is too large." });
    console.error("Store request failed:", error.name ?? "Error");
    res.status(500).json({ error: "Something went wrong. Please try again." });
  });
  return app;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const port = Number(process.env.PORT) || 3001;
  const app = createApp();
  const server = app.listen(port, "0.0.0.0", () =>
    console.log(
      `Leafivo store listening on port ${port} (${process.env.STORE_MODE ?? "preview"} mode)`,
    ),
  );
  const shutdown = () =>
    server.close(() => {
      app.locals.close();
      process.exit(0);
    });
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
