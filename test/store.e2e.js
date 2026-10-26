import { test, expect } from "@playwright/test";

const adminToken = "leafivo-e2e-only-owner-token-not-for-production";
const ownerHeaders = { Authorization: `Bearer ${adminToken}` };

const browserErrors = new WeakMap();

test.beforeEach(async ({ page }) => {
  const errors = [];
  browserErrors.set(page, errors);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    window.__leafivoCspViolations = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      window.__leafivoCspViolations.push({
        directive: event.effectiveDirective,
        blocked: event.blockedURI,
      });
    });
  });
  await page.goto("/");
  await expect(page.locator(".product-card")).toHaveCount(6);
});

test.afterEach(async ({ page }) => {
  expect(browserErrors.get(page), "No uncaught browser exceptions").toEqual([]);
  if (!page.isClosed()) {
    expect(
      await page.evaluate(() => window.__leafivoCspViolations ?? []),
      "Production CSP allows intended storefront features without violations",
    ).toEqual([]);
  }
});

test("catalog filtering, sorting, search, and saved products work together", async ({
  page,
}) => {
  await expect(
    page.getByRole("heading", { name: /Your next.*chapter/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Templates", exact: true }).click();
  await expect(page.locator(".product-card")).toHaveCount(2);
  await page.getByRole("button", { name: /^All products/ }).click();
  await page.getByLabel("Sort products").selectOption("price-low");
  await expect(
    page
      .locator(".product-card")
      .first()
      .getByRole("button", { name: "The Everyday Planner", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Search products", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Search the catalog" })
    .fill("starting");
  await expect(page.locator(".product-card")).toHaveCount(1);
  await page
    .getByRole("button", { name: "Save The Art of Starting", exact: true })
    .click();
  await page.getByRole("button", { name: "Clear search", exact: true }).click();
  await page.getByRole("button", { name: "Saved", exact: true }).click();
  await expect(page.locator(".product-card")).toHaveCount(1);
  await page.reload();
  await page.getByRole("button", { name: "Saved", exact: true }).click();
  await expect(page.locator(".product-card")).toHaveCount(1);
  await expect(
    page.getByRole("button", {
      name: "Unsave The Art of Starting",
      exact: true,
    }),
  ).toHaveAttribute("aria-pressed", "true");
});

test("shared product links open the right details and Escape restores the shop", async ({
  page,
}) => {
  await page.goto("/#product/the-art-of-starting");
  await expect(
    page.getByRole("dialog", { name: "The Art of Starting", exact: true }),
  ).toBeVisible();
  await expect(page).toHaveTitle("The Art of Starting — Leafivo");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page).toHaveURL(/#shop$/);
  await page.reload();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.goto("/#product/%");
  await expect(page.locator(".product-card")).toHaveCount(6);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("product details, bag quantity, persistence, and removal work", async ({
  page,
}) => {
  await page
    .getByRole("button", { name: "View The Art of Starting", exact: true })
    .click();
  const details = page.getByRole("dialog", {
    name: "The Art of Starting",
    exact: true,
  });
  await expect(
    details.getByText(/Sample product.*No ebook file is included/),
  ).toBeVisible();
  await details.getByRole("button", { name: /Add to bag/ }).click();
  await details.getByRole("button", { name: "Close dialog" }).click();
  await page
    .getByRole("button", { name: "Open shopping bag, 1 items" })
    .click();
  const bag = page.getByRole("dialog", { name: "Your shopping bag" });
  await bag
    .getByRole("button", { name: "Increase The Art of Starting quantity" })
    .click();
  await expect(bag.getByLabel("Quantity", { exact: true })).toHaveText("2");
  await expect(bag.getByText("$48", { exact: true }).first()).toBeVisible();
  await page.reload();
  await page
    .getByRole("button", { name: "Open shopping bag, 2 items" })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Remove The Art of Starting" })
    .click();
  await expect(page.getByText("Your next idea is out there.")).toBeVisible();
});

test("preview checkout saves an unpaid sample order and clears the bag", async ({
  page,
  request,
}) => {
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
  const email = `preview-${Date.now()}@example.com`;
  await page.getByRole("textbox", { name: "Email for your order" }).fill(email);
  await page.getByRole("button", { name: "Place sample order" }).click();
  await expect(
    page.getByRole("dialog", { name: "Sample order confirmation" }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Your sample order has been saved. No payment was taken and no products will be delivered.",
    ),
  ).toBeVisible();
  const response = await request.get("/api/admin/overview", {
    headers: ownerHeaders,
  });
  expect(response.ok()).toBeTruthy();
  const overview = await response.json();
  const order = overview.orders.find((order) => order.email === email);
  expect(order.status).toBe("preview");
  expect(order.total).toBe(2400);
  expect(overview.stats.paidOrders).toBe(0);
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Open shopping bag, 0 items" }),
  ).toBeVisible();
});

test("newsletter requires consent and persists the signup", async ({
  page,
  request,
}) => {
  const join = page.getByRole("button", { name: "Join the email list" });
  await expect(join).toBeDisabled();
  const email = `reader-${Date.now()}@example.com`;
  await page.getByLabel("Your next chapter, delivered.").fill(email);
  await page.getByRole("checkbox", { name: /I agree to receive/ }).check();
  await join.click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Your interest has been saved" }),
  ).toBeVisible();
  const overview = await (
    await request.get("/api/admin/overview", { headers: ownerHeaders })
  ).json();
  expect(
    overview.subscribers.some((subscriber) => subscriber.email === email),
  ).toBeTruthy();
  await expect(
    page.getByRole("checkbox", { name: /I agree to receive/ }),
  ).not.toBeChecked();
});

test("owner authentication protects catalog creation, editing, and removal", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Store studio" }).click();
  await page
    .getByRole("button", { name: "Product catalog", exact: true })
    .click();
  await page.getByLabel("Admin access key").fill("incorrect-key");
  await page.getByRole("button", { name: "Open your dashboard" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "valid store management token",
  );
  await page.getByLabel("Admin access key").fill(adminToken);
  await page.getByRole("button", { name: "Open your dashboard" }).click();
  await expect(
    page.getByRole("heading", { name: "Recent orders" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Product catalog", exact: true })
    .click();
  await page.getByRole("button", { name: "Add a product" }).click();
  const editor = page.getByRole("dialog", { name: "Edit product" });
  await editor
    .getByLabel("Product title", { exact: true })
    .fill("Browser Test Workbook");
  await editor
    .getByLabel("Short subtitle", { exact: true })
    .fill("A sample created in an isolated test database.");
  await editor
    .getByLabel("Description", { exact: true })
    .fill(
      "This listing demonstrates owner catalog creation without modifying the real store database.",
    );
  await editor.getByLabel("Price (USD)", { exact: true }).fill("27.50");
  await editor.getByRole("button", { name: "Save product" }).click();
  await expect(editor).not.toBeVisible();
  let listing = page
    .locator(".admin-product")
    .filter({
      has: page.getByRole("heading", {
        name: "Browser Test Workbook",
        exact: true,
      }),
    });
  await expect(listing.getByText("$27.50", { exact: true })).toBeVisible();
  await listing.getByRole("button", { name: "Edit product" }).click();
  await page
    .getByRole("dialog", { name: "Edit product" })
    .getByLabel("Product title", { exact: true })
    .fill("Updated Browser Workbook");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Save product" })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "Updated Browser Workbook",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Delete Updated Browser Workbook" })
    .click();
  await page
    .getByRole("dialog", { name: "Delete product" })
    .getByRole("button", { name: "Remove listing" })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "Updated Browser Workbook",
      exact: true,
    }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByLabel("Admin access key")).toBeVisible();
});

test("launch kit produces platform-specific drafts and a downloadable PNG", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Store studio" }).click();
  await expect(
    page.getByRole("heading", { name: "A good launch starts with a story." }),
  ).toBeVisible();
  await page.getByLabel("Featured product").selectOption("make-room-for-more");
  await page.getByLabel("Social platform").selectOption("TikTok");
  await expect(page.getByLabel("Your draft caption")).toHaveValue(
    /Make Room for More/,
  );
  await expect(page.getByLabel("Your draft caption")).toHaveValue(/#BookTok/);
  await expect(
    page.getByText(
      "Nothing is posted automatically, and no advertising money is spent.",
    ),
  ).toBeVisible();
  await page
    .getByLabel("Your draft caption")
    .fill("My own launch message with my real product link.");
  await expect(page.getByLabel("Your draft caption")).toHaveValue(
    "My own launch message with my real product link.",
  );
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download social image" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(
    /make-room-for-more-social\.png$/,
  );
  expect(await download.failure()).toBeNull();
});

test("mobile navigation, product details, and bag fit a narrow screen", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("button", { name: "Toggle navigation" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Toggle navigation" }).click();
  await expect(
    page.getByRole("button", { name: "Toggle navigation" }),
  ).toHaveAttribute("aria-expanded", "true");
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name: "Ebooks & guides" })
    .click();
  await expect(page.locator(".product-card")).toHaveCount(3);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBeTruthy();
  await page
    .getByRole("button", { name: "View A Little More Focus", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /Add to bag/ })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Close dialog" })
    .click();
  await page
    .getByRole("button", { name: "Open shopping bag, 1 items" })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Your shopping bag" }),
  ).toBeVisible();
  const bounds = await page.getByRole("dialog").boundingBox();
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.width).toBeLessThanOrEqual(390);
  await expect(
    page.getByRole("button", { name: "Try preview checkout" }),
  ).toBeVisible();
});


test("production responses enforce script, frame, and referrer restrictions", async ({ page }) => {
  const response = await page.goto("/");
  const headers = response.headers();
  expect(headers["content-security-policy"]).toContain("script-src 'self'");
  expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(headers["content-security-policy"]).not.toContain("'unsafe-inline'");
  expect(headers["content-security-policy"]).not.toContain("'unsafe-eval'");
  expect(headers["x-frame-options"]).toBe("DENY");
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["referrer-policy"]).toBe("no-referrer");
  await expect(page.locator(".product-card")).toHaveCount(6);
});

test("paid receipt uses an authorization header without leaking its capability", async ({ page }) => {
  const token = "test-only-receipt-capability-not-a-real-secret";
  const orderId = "security-paid-order";
  const requests = [];
  const observedUrls = [];
  page.on("request", (request) => observedUrls.push(request.url()));
  await page.route(`**/api/orders/${orderId}`, async (route) => {
    requests.push({ url: route.request().url(), headers: route.request().headers() });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: orderId, status: "paid", total: 2400, currency: "usd",
        items: [{ productId: "the-art-of-starting", title: "The Art of Starting", quantity: 1, price: 2400,
          downloadUrl: `/api/downloads/${orderId}/the-art-of-starting?expires=9999999999999&signature=test-only-signature` }],
      }),
    });
  });
  await page.goto(`/?checkout=success#receipt?order=${orderId}&token=${token}`);
  const receipt = page.getByRole("dialog", { name: "Payment status and downloads" });
  await expect(receipt.getByText("PAYMENT CONFIRMED", { exact: true })).toBeVisible();
  await expect(receipt.getByRole("link", { name: "Download", exact: true })).toHaveAttribute("href", /\/api\/downloads\/security-paid-order\//);
  await expect(page).toHaveURL("http://127.0.0.1:3101/");
  expect(requests).toHaveLength(1);
  expect(new URL(requests[0].url).search).toBe("");
  expect(requests[0].headers.authorization).toBe(`Bearer ${token}`);
  expect(observedUrls.some(url => url.includes(token))).toBe(false);
  expect(await page.locator("body").textContent()).not.toContain(token);
  expect(await page.evaluate((capability) => {
    const values = [...Object.values(localStorage), ...Object.values(sessionStorage)];
    return values.some(value => value.includes(capability));
  }, token)).toBe(false);
});

test("refunded receipt shows revoked access and offers no download", async ({ page }) => {
  const orderId = "security-refunded-order";
  await page.route(`**/api/orders/${orderId}`, route => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ id: orderId, status: "refunded", total: 2400, currency: "usd", items: [
      { productId: "the-art-of-starting", title: "The Art of Starting", quantity: 1, price: 2400 },
    ] }),
  }));
  await page.goto(`/?checkout=success#receipt?order=${orderId}&token=test-only-refunded-capability`);
  const receipt = page.getByRole("dialog", { name: "Payment status and downloads" });
  await expect(receipt.getByText(/This order has been refunded or disputed/)).toBeVisible();
  await expect(receipt.getByText("DOWNLOAD ACCESS ON HOLD", { exact: true })).toBeVisible();
  await expect(receipt.getByRole("heading", { name: "Access on hold.", exact: true })).toBeVisible();
  await expect(receipt.getByRole("link", { name: "Download", exact: true })).toHaveCount(0);
  await expect(receipt.getByText("PAYMENT CONFIRMED", { exact: true })).toHaveCount(0);
  await expect(receipt.getByText("CHECKING YOUR PAYMENT", { exact: true })).toHaveCount(0);
  await expect(receipt.getByRole("heading", { name: "Almost there.", exact: true })).toHaveCount(0);
});

test("corrupted browser storage does not crash the store or create bag items", async ({ page }) => {
  await page.evaluate(() => {
    localStorage.setItem("chapter.cart", "[null]");
    localStorage.setItem("chapter.favorites", '[null,{},123]');
  });
  await page.reload();
  await expect(page.locator(".product-card")).toHaveCount(6);
  await page.getByRole("button", { name: "Open shopping bag, 0 items" }).click();
  await expect(page.getByText("Your next idea is out there.")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Saved", exact: true }).click();
  await expect(page.locator(".product-card")).toHaveCount(0);
  await expect(page.getByText("A place for your next favorites.")).toBeVisible();
});

test("stored product markup renders as text without executing or creating HTML", async ({ page, request }) => {
  const title = '<img src=x onerror="window.__leafivoXss=1">';
  const description = '<script>window.__leafivoXss=2</script> Sample text, not executable HTML.';
  const response = await request.post("/api/admin/products", {
    headers: { ...ownerHeaders, Origin: "http://127.0.0.1:3101" },
    data: { title, description, subtitle: "A stored markup escaping test.", sample: true },
  });
  expect(response.status()).toBe(201);
  const product = await response.json();
  try {
    await page.reload();
    await expect(page.locator(".product-card")).toHaveCount(7);
    await page.getByRole("button", { name: title, exact: true }).click();
    const dialog = page.getByRole("dialog", { name: title, exact: true });
    await expect(dialog.getByRole("heading", { name: title, exact: true })).toBeVisible();
    await expect(dialog.getByText(description, { exact: true })).toBeVisible();
    await expect(dialog.locator("img, script")).toHaveCount(0);
    expect(await page.evaluate(() => window.__leafivoXss)).toBeUndefined();
  } finally {
    const deletion = await request.delete(`/api/admin/products/${product.id}`, {
      headers: { ...ownerHeaders, Origin: "http://127.0.0.1:3101" },
    });
    expect(deletion.ok()).toBeTruthy();
  }
});
