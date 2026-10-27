import { test, expect } from "@playwright/test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/index.js";
import { ownerTotp } from "../server/owner-auth.js";
import express from "express";
import { securityHeaders } from "../server/security.js";

const SETUP = "browser-test-only-private-owner-bootstrap-123456789";
const AUTH_KEY = "browser-test-only-owner-encryption-key-1234567890";
const PASSWORD = "a unique browser owner learning passphrase";
const NEW_PASSWORD = "a different unique browser owner passphrase";
const USERNAME = "owner.browser";
const PDF = Buffer.from("%PDF-1.4\n1 0 obj <<>> endobj\n%%EOF\n");
let fixture;

test.setTimeout(60000);
test.beforeEach(async ({ page }) => {
  const dir = mkdtempSync(join(tmpdir(), "leafivo-owner-browser-"));
  mkdirSync(join(dir, "downloads"));
  fixture = { dir, app: null, server: null, base: "", errors: [] };
  fixture.start = async () => {
    fixture.app = createApp({
      dbPath: join(dir, "store.sqlite"),
      downloadDir: join(dir, "downloads"),
      mode: "preview",
      publicPreview: true,
      production: false,
      ownerManagementEnabled: true,
      ownerStoragePersistent: true,
      ownerAuthKey: AUTH_KEY,
      ownerSetupToken: SETUP,
      ownerSetupExpires: Date.now() + 60 * 60 * 1000,
      baseUrl: "",
      stripeSecretKey: "",
      stripeWebhookSecret: "",
      downloadSigningKey: "browser-test-only-download-signing-key-123456789",
    });
    // Exercise the exact production CSP while local auth uses a non-Secure HTTP cookie.
    const host = express();
    host.use(securityHeaders(true));
    host.use(fixture.app);
    fixture.server = await new Promise((resolve) => {
      const server = host.listen(0, "127.0.0.1", () => resolve(server));
    });
    fixture.base = `http://127.0.0.1:${fixture.server.address().port}`;
  };
  fixture.stop = async () => {
    if (fixture.server) {
      await new Promise((resolve) => fixture.server.close(resolve));
      fixture.server = null;
      fixture.app.locals.close();
      fixture.app = null;
    }
  };
  await fixture.start();
  await page.exposeFunction("__reportOwnerCsp", (directive) =>
    fixture.errors.push(`CSP: ${directive}`),
  );
  await page.addInitScript(() =>
    document.addEventListener("securitypolicyviolation", (event) =>
      window.__reportOwnerCsp(event.effectiveDirective),
    ),
  );
});
test.afterEach(async () => {
  try {
    expect(fixture.errors, "No uncaught owner browser errors").toEqual([]);
  } finally {
    await fixture.stop();
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

async function activate(page) {
  page.on("pageerror", (error) => fixture.errors.push(error.message));
  await page.goto(`${fixture.base}/#owner-setup?token=${SETUP}`);
  await expect(
    page.getByRole("heading", { name: "Create your owner login." }),
  ).toBeVisible();
  await expect(page).toHaveURL(`${fixture.base}/#owner`);
  await page.locator("#owner-new-username").fill(USERNAME);
  await page.locator("#owner-new-password").fill(PASSWORD);
  await page.locator("#owner-confirm-password").fill(PASSWORD);
  await page.getByRole("button", { name: "Continue to authenticator" }).click();
  await expect(
    page.getByRole("heading", { name: "A second layer of protection." }),
  ).toBeVisible();
  await expect(
    page.getByRole("img", { name: "Authenticator setup QR code", exact: true }),
  ).toBeVisible();
  await page.locator(".owner-manual-secret summary").click();
  const secret = (
    await page.locator(".owner-manual-secret code").innerText()
  ).trim();
  await page.locator("#owner-setup-code").fill(ownerTotp(secret));
  await page
    .getByRole("button", { name: "Verify and protect my account" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Save your recovery codes." }),
  ).toBeVisible();
  const recovery = await page
    .locator(".owner-recovery-codes code")
    .allTextContents();
  expect(recovery).toHaveLength(10);
  await expect(
    page.getByRole("button", { name: "Open my store studio" }),
  ).toBeDisabled();
  const downloadPromise = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Download recovery codes", exact: true })
    .click();
  const recoveryDownload = await downloadPromise;
  const savedCodes = readFileSync(await recoveryDownload.path(), "utf8");
  expect(savedCodes.includes("\n")).toBe(true);
  expect(recovery.every((code) => savedCodes.includes(code))).toBe(true);
  await page.getByLabel("I saved these codes somewhere private.").check();
  await page.getByRole("button", { name: "Open my store studio" }).click();
  await expect(
    page.getByRole("heading", { name: "Recent orders" }),
  ).toBeVisible();
  expect(
    await page.evaluate(() =>
      Object.keys(localStorage).some((key) =>
        /owner|password|csrf|totp/i.test(key),
      ),
    ),
  ).toBe(false);
  expect(await page.evaluate(() => Object.keys(sessionStorage))).toEqual([]);
  const cookie = (await page.context().cookies()).find(
    (item) => item.name === "leafivo_owner",
  );
  expect(Boolean(cookie?.httpOnly)).toBe(true);
  expect(cookie?.sameSite).toBe("Strict");
  return { secret, recovery };
}
async function logout(page) {
  await page
    .locator(".studio-tabs")
    .getByRole("button", { name: "Sign out", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Your private studio." }),
  ).toBeVisible();
}
async function login(page, { password = PASSWORD, code, recoveryCode } = {}) {
  await page.locator("#owner-login-username").fill(USERNAME);
  await page.locator("#owner-login-password").fill(password);
  if (recoveryCode) {
    await page
      .getByRole("button", { name: "Use a recovery code instead" })
      .click();
    await page.locator("#owner-login-recovery").fill(recoveryCode);
  } else {
    await page.locator("#owner-login-code").fill(code);
  }
  await page.getByRole("button", { name: /Sign in securely/ }).click();
  await expect(
    page.getByRole("heading", { name: "Recent orders" }),
  ).toBeVisible();
}

test("private owner activation, product editing/upload, durable restart and logout are real authenticated flows", async ({
  page,
  request,
}) => {
  const { secret, recovery } = await activate(page);
  const secondClaim = await page.request.post(
    `${fixture.base}/api/owner/setup/start`,
    {
      headers: { Origin: fixture.base },
      data: { setupToken: SETUP, username: "other.owner", password: PASSWORD },
    },
  );
  expect(secondClaim.ok()).toBe(false);
  expect(
    fixture.app.locals.store.db
      .prepare("SELECT count(*) AS count FROM owner_identity")
      .get().count,
  ).toBe(1);
  await page
    .getByRole("button", { name: "Product catalog", exact: true })
    .click();
  await page.getByRole("button", { name: "Add a product" }).click();
  const editor = page.getByRole("dialog", { name: "Edit product" });
  await editor
    .getByLabel("Product title", { exact: true })
    .fill("My private educational workbook");
  await editor
    .getByLabel("Short subtitle", { exact: true })
    .fill("Owned content for an isolated browser test.");
  await editor
    .getByLabel("Description", { exact: true })
    .fill(
      "A test workbook used to verify authenticated owner management and protected product delivery.",
    );
  await editor.getByLabel("Price (USD)", { exact: true }).fill("27.50");
  await editor.locator("#owner-product-file").setInputFiles({
    name: "owned-workbook.pdf",
    mimeType: "application/pdf",
    buffer: PDF,
  });
  await editor
    .getByRole("checkbox", {
      name: "I own this content or have permission to distribute it.",
    })
    .check();
  await editor
    .getByRole("checkbox", { name: "This is a sample product" })
    .uncheck();
  await editor.getByRole("button", { name: "Save product" }).click();
  await expect(editor).not.toBeVisible();
  const listing = page.locator(".admin-product").filter({
    has: page.getByRole("heading", {
      name: "My private educational workbook",
      exact: true,
    }),
  });
  await expect(listing.getByText("$27.50", { exact: true })).toBeVisible();
  await listing.getByRole("button", { name: "Edit product" }).click();
  const downloadPromise = page.waitForEvent("download");
  await page
    .getByRole("dialog")
    .getByRole("link", { name: "Review current private file" })
    .click();
  const download = await downloadPromise;
  expect(readFileSync(await download.path()).equals(PDF)).toBe(true);
  await page
    .getByRole("dialog")
    .getByLabel("Product title", { exact: true })
    .fill("Updated educational workbook");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Save product" })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "Updated educational workbook",
      exact: true,
    }),
  ).toBeVisible();
  const stored = fixture.app.locals.store
    .products()
    .find((product) => product.title === "Updated educational workbook");
  expect(stored.sample).toBe(false);
  expect(Boolean(stored.downloadFile)).toBe(true);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Recent orders" }),
  ).toBeVisible();
  await fixture.stop();
  await fixture.start();
  await page.goto(`${fixture.base}/#owner`);
  await expect(
    page.getByRole("heading", { name: "Recent orders" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Product catalog", exact: true })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "Updated educational workbook",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Delete Updated educational workbook" })
    .click();
  await page
    .getByRole("dialog", { name: "Delete product" })
    .getByRole("button", { name: "Remove listing" })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "Updated educational workbook",
      exact: true,
    }),
  ).toHaveCount(0);
  const oldCookie = (await page.context().cookies()).find(
    (item) => item.name === "leafivo_owner",
  );
  await logout(page);
  const revoked = await request.get(`${fixture.base}/api/admin/overview`, {
    headers: { Cookie: `leafivo_owner=${oldCookie.value}` },
  });
  expect(revoked.status()).toBe(401);
  const unauthorized = await request.post(
    `${fixture.base}/api/admin/products`,
    {
      headers: { Origin: fixture.base },
      data: { title: "Unauthorized", description: "Must not be written" },
    },
  );
  expect(unauthorized.status()).toBe(401);
  await login(page, { code: ownerTotp(secret, Date.now() + 30000) });
  await logout(page);
  await login(page, { recoveryCode: recovery[0] });
});

test("owner password changes require fresh authentication without dropping valid sessions on a bad recheck", async ({
  page,
  request,
}) => {
  const { secret, recovery } = await activate(page);
  await page
    .getByRole("button", { name: "Account security", exact: true })
    .click();
  await page
    .locator("#owner-security-current")
    .fill("a deliberately wrong owner password");
  await page.locator("#owner-security-new").fill(NEW_PASSWORD);
  await page.locator("#owner-security-confirm").fill(NEW_PASSWORD);
  await page
    .locator("#owner-security-code")
    .fill(ownerTotp(secret, Date.now() + 30000));
  await page.getByRole("button", { name: "Update password" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Owner security.", exact: true }),
  ).toBeVisible();
  await expect(page.locator("#owner-login-password")).toHaveCount(0);
  const before = (await page.context().cookies()).find(
    (item) => item.name === "leafivo_owner",
  );
  await page.locator("#owner-security-current").fill(PASSWORD);
  await page
    .locator("#owner-security-code")
    .fill(ownerTotp(secret, Date.now() + 30000));
  await page.getByRole("button", { name: "Update password" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Your password is updated." }),
  ).toBeVisible();
  const oldSession = await request.get(`${fixture.base}/api/admin/overview`, {
    headers: { Cookie: `leafivo_owner=${before.value}` },
  });
  expect(oldSession.status()).toBe(401);
  await logout(page);
  await login(page, { password: NEW_PASSWORD, recoveryCode: recovery[0] });
  await logout(page);
  await page.locator("#owner-login-username").fill(USERNAME);
  await page.locator("#owner-login-password").fill(NEW_PASSWORD);
  await page
    .getByRole("button", { name: "Use a recovery code instead" })
    .click();
  await page.locator("#owner-login-recovery").fill(recovery[0]);
  await page.getByRole("button", { name: /Sign in securely/ }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Your private studio." }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
});

test("an owner can replace a lost authenticator and save new recovery codes", async ({
  page,
}) => {
  const { secret, recovery } = await activate(page);
  await logout(page);
  await login(page, { recoveryCode: recovery[0] });
  await page
    .getByRole("button", { name: "Account security", exact: true })
    .click();
  await page.getByRole("button", { name: "Replace my authenticator" }).click();
  await page.locator("#owner-reset-password").fill(PASSWORD);
  await page.locator("#owner-reset-recovery").fill(recovery[1]);
  await page
    .getByRole("button", { name: "Connect a replacement authenticator" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Connect your new app." }),
  ).toBeVisible();
  await page.locator(".owner-manual-secret summary").click();
  const replacement = (
    await page.locator(".owner-manual-secret code").innerText()
  ).trim();
  expect(replacement === secret).toBe(false);
  await page.locator("#owner-reset-code").fill(ownerTotp(replacement));
  await page.getByRole("button", { name: "Verify new authenticator" }).click();
  await expect(
    page.getByRole("heading", { name: "Save the replacement codes." }),
  ).toBeVisible();
  const newCodes = await page
    .locator(".owner-recovery-codes code")
    .allTextContents();
  expect(newCodes).toHaveLength(10);
  expect(newCodes.some((code) => recovery.includes(code))).toBe(false);
  await expect(
    page.getByRole("button", { name: "Finish authenticator replacement" }),
  ).toBeDisabled();
  await page.getByLabel("I saved the new codes somewhere private.").check();
  await page
    .getByRole("button", { name: "Finish authenticator replacement" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Owner security.", exact: true }),
  ).toBeVisible();
  await logout(page);
  await page.locator("#owner-login-username").fill(USERNAME);
  await page.locator("#owner-login-password").fill(PASSWORD);
  await page
    .locator("#owner-login-code")
    .fill(ownerTotp(secret, Date.now() + 30000));
  await page.getByRole("button", { name: /Sign in securely/ }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await page
    .locator("#owner-login-code")
    .fill(ownerTotp(replacement, Date.now() + 30000));
  await page.getByRole("button", { name: /Sign in securely/ }).click();
  await expect(
    page.getByRole("heading", { name: "Recent orders" }),
  ).toBeVisible();
});

test("failed sign-out is reported honestly and inactivity locks the screen until a fresh login", async ({
  page,
}) => {
  await page.clock.install();
  const { secret } = await activate(page);
  const logoutPattern = "**/api/owner/logout";
  await page.route(logoutPattern, (route) => route.abort("failed"));
  await page
    .locator(".studio-tabs")
    .getByRole("button", { name: "Sign out", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "Sign-out could not be confirmed.",
  );
  await expect(
    page.getByRole("heading", { name: "Recent orders" }),
  ).toBeVisible();
  expect(
    (await (await page.request.get(`${fixture.base}/api/owner/session`)).json())
      .authenticated,
  ).toBe(true);
  await page.clock.fastForward(15 * 60 * 1000 + 1000);
  await expect(
    page.getByRole("heading", { name: "Your private studio." }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Recent orders" }),
  ).toHaveCount(0);
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Server sign-out could not be confirmed." }),
  ).toBeVisible();
  expect(
    (await (await page.request.get(`${fixture.base}/api/owner/session`)).json())
      .authenticated,
  ).toBe(true);
  await page.unroute(logoutPattern);
  await login(page, { code: ownerTotp(secret, Date.now() + 30000) });
  await logout(page);
  expect(
    (await (await page.request.get(`${fixture.base}/api/owner/session`)).json())
      .authenticated,
  ).toBe(false);
});
