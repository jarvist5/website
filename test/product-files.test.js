import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createStore } from "../server/store.js";
import { createProductFileHandler } from "../server/product-files.js";

const PRODUCT = "the-art-of-starting";
const PDF = Buffer.from("%PDF-1.7\nA test ebook body\n%%EOF");
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x01, 0x02, 0x03, 0x04]);
const KEY = "product-upload-test-key-not-a-production-secret";

async function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "leafivo-product-files-"));
  const downloads = join(dir, "downloads");
  const store = createStore(":memory:");
  const uploader = createProductFileHandler({
    store,
    downloadDir: downloads,
    ...options,
  });
  const app = express();
  app.put(
    "/api/admin/products/:id/file",
    (req, res, next) => {
      if (req.get("Authorization") !== `Bearer ${KEY}`)
        return res.status(401).json({ error: "Owner authentication required" });
      next();
    },
    express.raw({
      type: () => true,
      limit: options.maxBytes ?? 25 * 1024 * 1024,
    }),
    uploader,
  );
  app.use((error, req, res, next) => {
    res
      .status(error.type === "entity.too.large" ? 413 : 500)
      .json({
        error:
          error.type === "entity.too.large"
            ? "File is too large"
            : "Upload failed",
      });
  });
  const server = await new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const upload = async (
    body = PDF,
    {
      id = PRODUCT,
      auth = true,
      headers = {},
      rights = "owned-or-licensed",
      type = "application/pdf",
    } = {},
  ) => {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/api/admin/products/${encodeURIComponent(id)}/file`,
      {
        method: "PUT",
        headers: {
          "Content-Type": type,
          ...(auth ? { Authorization: `Bearer ${KEY}` } : {}),
          ...(rights ? { "X-Content-Rights": rights } : {}),
          ...headers,
        },
        ...(body !== undefined ? { body } : {}),
      },
    );
    return { status: response.status, body: await response.json() };
  };
  return { dir, downloads, store, upload };
}

test("owner upload persists a private PDF and exposes no private filename", async (t) => {
  const { upload, downloads, store } = await fixture(t);
  const before = store.product(PRODUCT);
  const response = await upload();
  assert.equal(response.status, 200);
  assert.equal(response.body.product.id, PRODUCT);
  assert.equal(response.body.product.downloadReady, true);
  assert.equal("downloadFile" in response.body.product, false);
  const saved = store.product(PRODUCT);
  assert.equal(saved.sample, before.sample);
  assert.equal(saved.title, before.title);
  assert.match(saved.downloadFile, /^[A-Za-z0-9_-]+\.pdf$/);
  assert.equal(
    readFileSync(join(downloads, saved.downloadFile)).compare(PDF),
    0,
  );
  assert.equal(
    statSync(join(downloads, saved.downloadFile)).mode & 0o777,
    0o600,
  );
  assert.equal(statSync(downloads).mode & 0o777, 0o700);
});

test("unauthenticated uploads are rejected before file parsing or storage", async (t) => {
  const { upload, downloads, store } = await fixture(t, { maxBytes: 100 });
  const response = await upload(Buffer.alloc(1024, 0x41), { auth: false });
  assert.equal(response.status, 401);
  assert.equal(store.product(PRODUCT).downloadFile, undefined);
  assert.equal(existsSync(downloads) ? readdirSync(downloads).length : 0, 0);
});

test("upload requires an explicit content-rights declaration", async (t) => {
  const { upload, downloads, store } = await fixture(t);
  for (const rights of [null, "", "yes", "public-domain-claimed"]) {
    assert.equal((await upload(PDF, { rights })).status, 400);
  }
  assert.equal(store.product(PRODUCT).downloadFile, undefined);
  assert.equal(existsSync(downloads) ? readdirSync(downloads).length : 0, 0);
});

test("PDF, EPUB and ZIP uploads validate MIME type, format and magic", async (t) => {
  const { upload, downloads, store } = await fixture(t);
  for (const [type, format, body, extension] of [
    ["application/pdf", "pdf", PDF, "pdf"],
    ["application/epub+zip", "epub", ZIP, "epub"],
    ["application/zip", "zip", ZIP, "zip"],
    ["application/octet-stream", "pdf", PDF, "pdf"],
  ]) {
    const response = await upload(body, {
      type,
      headers: { "X-File-Format": format },
    });
    assert.equal(response.status, 200, `${type}/${format}`);
    assert.ok(store.product(PRODUCT).downloadFile.endsWith(`.${extension}`));
  }
  assert.equal(readdirSync(downloads).length, 4);
  assert.equal((await upload(PDF, { type: "text/html" })).status, 415);
  assert.equal(
    (await upload(PDF, { type: "application/octet-stream" })).status,
    415,
  );
  assert.equal(
    (await upload(PDF, { headers: { "X-File-Format": "zip" } })).status,
    415,
  );
  assert.equal(
    (await upload(PDF, { headers: { "X-File-Format": "../../secret" } }))
      .status,
    415,
  );
  assert.equal(
    (await upload(Buffer.from("<script>bad()</script>"))).status,
    400,
  );
  assert.equal((await upload(PDF, { type: "application/zip" })).status, 400);
  assert.equal(
    (
      await upload(Buffer.from("PK looks like a ZIP"), {
        type: "application/zip",
      })
    ).status,
    400,
  );
});

test("empty, excessive, and missing-product bodies do not create files", async (t) => {
  const { upload, downloads } = await fixture(t, { maxBytes: 100 });
  assert.equal((await upload(Buffer.alloc(0))).status, 400);
  assert.equal((await upload(Buffer.alloc(101, 0x41))).status, 413);
  assert.equal((await upload(PDF, { id: "nonexistent-product" })).status, 404);
  assert.equal((await upload(PDF, { id: "../../outside" })).status, 404);
  assert.equal(existsSync(downloads) ? readdirSync(downloads).length : 0, 0);
});

test("replacing a product file preserves previous paid-order file versions", async (t) => {
  const { upload, downloads, store } = await fixture(t);
  const first = await upload();
  assert.equal(first.status, 200);
  const oldName = store.product(PRODUCT).downloadFile;
  const secondBody = Buffer.from("%PDF-1.7\nReplacement owned edition\n%%EOF");
  assert.equal((await upload(secondBody)).status, 200);
  const newName = store.product(PRODUCT).downloadFile;
  assert.notEqual(newName, oldName);
  assert.equal(readFileSync(join(downloads, oldName)).compare(PDF), 0);
  assert.equal(readFileSync(join(downloads, newName)).compare(secondBody), 0);
});

test("quota exhaustion preserves catalog and existing files", async (t) => {
  const { upload, downloads, store } = await fixture(t, {
    maxStorageBytes: PDF.length,
    maxFiles: 2,
  });
  assert.equal((await upload()).status, 200);
  const current = store.product(PRODUCT).downloadFile;
  assert.equal((await upload()).status, 507);
  assert.equal(store.product(PRODUCT).downloadFile, current);
  assert.deepEqual(readdirSync(downloads), [current]);
});

test("file-count quota cannot be exceeded", async (t) => {
  const { upload, downloads, store } = await fixture(t, { maxFiles: 1 });
  assert.equal((await upload()).status, 200);
  const current = store.product(PRODUCT).downloadFile;
  assert.equal((await upload()).status, 507);
  assert.deepEqual(readdirSync(downloads), [current]);
});

test("symbolic links inside upload storage are not traversed or overwritten", async (t) => {
  const { upload, dir, downloads, store } = await fixture(t);
  mkdirSync(downloads, { mode: 0o700 });
  const outside = join(dir, "outside.pdf");
  writeFileSync(outside, "outside-owned-file");
  symlinkSync(outside, join(downloads, "linked.pdf"));
  assert.equal((await upload()).status, 507);
  assert.equal(readFileSync(outside, "utf8"), "outside-owned-file");
  assert.equal(store.product(PRODUCT).downloadFile, undefined);
  assert.deepEqual(readdirSync(downloads), ["linked.pdf"]);
});

test("a catalog persistence failure removes only the uncommitted new upload", async (t) => {
  const { upload, downloads, store } = await fixture(t);
  assert.equal((await upload()).status, 200);
  const oldName = store.product(PRODUCT).downloadFile;
  const originalSave = store.saveProduct;
  store.saveProduct = () => {
    throw new Error("Simulated SQLite failure");
  };
  assert.equal((await upload()).status, 500);
  store.saveProduct = originalSave;
  assert.equal(store.product(PRODUCT).downloadFile, oldName);
  assert.deepEqual(readdirSync(downloads), [oldName]);
});

test("a symbolic-link storage root cannot redirect owner writes", async (t) => {
  const { upload, dir, downloads, store } = await fixture(t);
  const outside = join(dir, "outside-storage");
  mkdirSync(outside);
  symlinkSync(outside, downloads, "dir");
  assert.equal((await upload()).status, 507);
  assert.deepEqual(readdirSync(outside), []);
  assert.equal(store.product(PRODUCT).downloadFile, undefined);
});

test("uploading a new edition preserves a real listing's sample and sale metadata", async (t) => {
  const { upload, store, downloads } = await fixture(t);
  const before = {
    ...store.product(PRODUCT),
    sample: false,
    price: 7654,
    title: "The owner’s licensed edition",
    featured: false,
  };
  store.saveProduct(before);
  const response = await upload(PDF, {
    headers: { "X-Filename": "../../do-not-use.pdf" },
  });
  assert.equal(response.status, 200);
  const saved = store.product(PRODUCT);
  assert.equal(saved.sample, false);
  assert.equal(saved.price, 7654);
  assert.equal(saved.title, before.title);
  assert.equal(saved.featured, false);
  assert.match(saved.downloadFile, /^[A-Za-z0-9_-]+\.pdf$/);
  assert.equal(readdirSync(downloads).length, 1);
});
