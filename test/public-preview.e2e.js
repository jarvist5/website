import { test, expect } from "@playwright/test";
import { createApp } from "../server/index.js";

let app, server, base;
test.beforeAll(async () => {
  app = createApp({
    dbPath: ":memory:",
    mode: "preview",
    publicPreview: true,
    production: true,
    baseUrl: "",
    adminToken: "test-public-preview-owner-key-never-production",
    stripeSecretKey: "",
    stripeWebhookSecret: "",
  });
  server = await new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  app.locals.close();
});

test("public preview is browseable without collecting email or exposing owner access", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const response = await page.goto(base);
  expect(response.headers()["x-robots-tag"]).toBe("noindex, nofollow");
  expect(response.headers()["content-security-policy"]).toContain(
    "frame-ancestors 'none'",
  );
  await expect(page.locator(".product-card")).toHaveCount(6);
  await expect(page.getByLabel("Your next chapter, delivered.")).toHaveCount(0);
  await expect(page.locator("#newsletter-email")).toHaveCount(0);
  await expect(
    page.getByText("Public preview · Email collection is turned off."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Store studio" }).click();
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "A first look, just for you." }),
  ).toBeVisible();
  await expect(page.locator("#admin-token")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("public practice checkout needs no personal details and saves no customer records", async ({
  page,
}) => {
  await page.goto(base);
  await page
    .getByRole("button", { name: "View The Art of Starting", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /Add to bag/ })
    .click();
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "Open shopping bag, 1 items" })
    .click();
  await page.getByRole("button", { name: "Try preview checkout" }).click();
  await expect(page.locator("#checkout-email")).toHaveCount(0);
  const request = page.waitForRequest(
    (r) => r.url().endsWith("/api/checkout") && r.method() === "POST",
  );
  await page.getByRole("button", { name: "Place sample order" }).click();
  expect((await request).postDataJSON()).not.toHaveProperty("email");
  await expect(
    page.getByRole("dialog", { name: "Sample order confirmation" }),
  ).toBeVisible();
  await expect(
    page.getByText(
      /Your practice checkout is complete. No payment was taken, no order or email was saved/,
    ),
  ).toBeVisible();
  expect(app.locals.store.overview().stats.previewOrders).toBe(0);
  expect(app.locals.store.overview().stats.subscribers).toBe(0);
});
