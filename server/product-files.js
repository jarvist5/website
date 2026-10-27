import { randomUUID } from "node:crypto";
import {
  existsSync,
  closeSync,
  fsyncSync,
  openSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_STORAGE_BYTES = 500 * 1024 * 1024;
const MAX_FILES = 1000;
const mediaFormats = new Map([
  ["application/pdf", "pdf"],
  ["application/epub+zip", "epub"],
  ["application/zip", "zip"],
]);
const formats = new Set(["pdf", "epub", "zip"]);
const header = (req, name) =>
  req.get?.(name) ?? req.headers?.[name.toLowerCase()];
const inside = (root, target) => {
  const path = relative(root, target);
  return path !== ".." && !path.startsWith("../") && !isAbsolute(path);
};
const validBound = (value, ceiling) =>
  Number.isSafeInteger(value) && value > 0 && value <= ceiling;

// Never follow links while accounting for uploaded files, and bound directory work.
function usedStorage(root, maxFiles, maxStorageBytes) {
  let files = 0;
  let bytes = 0;
  let entries = 0;
  const directories = [root];
  while (directories.length) {
    const directory = directories.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (++entries > 5000) return null;
      const path = resolve(directory, entry.name);
      const stat = lstatSync(path);
      if (!inside(root, path) || stat.isSymbolicLink()) return null;
      if (stat.isDirectory()) directories.push(path);
      else if (stat.isFile()) {
        files++;
        bytes += stat.size;
        if (files >= maxFiles || bytes > maxStorageBytes) return null;
      } else return null;
    }
  }
  return { files, bytes };
}

/**
 * Attach this handler only AFTER owner authentication/CSRF and bounded raw parsing.
 * File-header validation is not malware scanning or a content-rights determination.
 */
export function createProductFileHandler({
  store,
  downloadDir,
  maxBytes = MAX_FILE_BYTES,
  maxStorageBytes = MAX_STORAGE_BYTES,
  maxFiles = MAX_FILES,
}) {
  if (
    !store?.product ||
    !store?.saveProduct ||
    typeof downloadDir !== "string" ||
    !downloadDir
  )
    throw new TypeError(
      "Product upload requires a store and private download directory.",
    );
  if (
    !validBound(maxBytes, MAX_FILE_BYTES) ||
    !validBound(maxStorageBytes, MAX_STORAGE_BYTES) ||
    !validBound(maxFiles, MAX_FILES)
  )
    throw new RangeError(
      "Product upload limits must remain within the supported bounds.",
    );
  const configuredRoot = resolve(downloadDir);
  return (req, res, next) => {
    const product = store.product(req.params.id);
    if (!product) return res.status(404).json({ error: "Product not found." });
    if (header(req, "X-Content-Rights") !== "owned-or-licensed")
      return res.status(400).json({
        error: "Confirm that you own or are licensed to distribute this file.",
      });
    const type = String(header(req, "Content-Type") ?? "")
      .split(";")[0]
      .trim()
      .toLowerCase();
    const declared = String(header(req, "X-File-Format") ?? "")
      .trim()
      .toLowerCase();
    const expected = mediaFormats.get(type);
    if (
      (!expected && type !== "application/octet-stream") ||
      (declared &&
        (!formats.has(declared) || (expected && declared !== expected))) ||
      (!expected && !formats.has(declared))
    )
      return res.status(415).json({
        error: "Upload a PDF, EPUB, or ZIP with a matching file format.",
      });
    const format = expected || declared;
    if (!Buffer.isBuffer(req.body) || req.body.length === 0)
      return res.status(400).json({ error: "Choose a nonempty product file." });
    if (req.body.length > maxBytes)
      return res
        .status(413)
        .json({ error: "The product file exceeds the upload size limit." });
    const pdf = req.body.subarray(0, 5).equals(Buffer.from("%PDF-"));
    const zip = req.body
      .subarray(0, 4)
      .equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    if ((format === "pdf" && !pdf) || (format !== "pdf" && !zip))
      return res.status(400).json({
        error:
          "The file contents do not match the selected PDF, EPUB, or ZIP format.",
      });
    let destination;
    let created = false;
    try {
      mkdirSync(configuredRoot, { recursive: true, mode: 0o700 });
      if (
        lstatSync(configuredRoot).isSymbolicLink() ||
        !lstatSync(configuredRoot).isDirectory()
      )
        return res.status(507).json({
          error:
            "Private product storage is unavailable. Contact the store owner.",
        });
      const root = realpathSync(configuredRoot);
      const used = usedStorage(root, maxFiles, maxStorageBytes);
      if (
        !used ||
        used.files >= maxFiles ||
        used.bytes + req.body.length > maxStorageBytes
      )
        return res.status(507).json({
          error: "Private product storage is full or needs an owner review.",
        });
      const filename = `${randomUUID()}.${format}`;
      destination = resolve(root, filename);
      if (!inside(root, destination))
        throw new Error("Invalid private product destination");
      // An exclusive create cannot overwrite a prior product file or follow a target link.
      const descriptor = openSync(destination, "wx", 0o600);
      created = true;
      try {
        writeFileSync(descriptor, req.body);
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      const productWithFile = { ...product, downloadFile: filename };
      store.saveProduct(productWithFile);
      const { downloadFile, ...publicProduct } = productWithFile;
      return res.status(200).json({
        product: { ...publicProduct, downloadReady: true },
        message:
          "Private product file uploaded. Review its contents and listing before making it available for sale.",
      });
    } catch (error) {
      // Remove only this request's new orphan; old files may belong to paid orders.
      if (created && destination && existsSync(destination)) {
        try {
          unlinkSync(destination);
        } catch {
          /* Leave the private orphan for owner reconciliation. */
        }
      }
      if (["ENOSPC", "EDQUOT"].includes(error.code))
        return res
          .status(507)
          .json({ error: "Private product storage is full." });
      if (["EACCES", "EPERM", "ENOENT", "ENOTDIR"].includes(error.code))
        return res.status(503).json({
          error: "Private product storage is temporarily unavailable.",
        });
      return next(error);
    }
  };
}
