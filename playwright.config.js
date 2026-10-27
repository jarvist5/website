import { defineConfig } from "@playwright/test";
import chromium from "@sparticuz/chromium";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testDatabase =
  process.env.LEAFIVO_E2E_DB ||
  join(tmpdir(), `leafivo-e2e-${process.pid}-${Date.now()}`, "store.sqlite");
process.env.LEAFIVO_E2E_DB = testDatabase;
export default defineConfig({
  testDir: "./test",
  testMatch: "**/*.e2e.js",
  timeout: 30000,
  expect: { timeout: 7000 },
  workers: 1,
  fullyParallel: false,
  reporter: "list",
  outputDir: "./test-results",
  use: {
    baseURL: "http://127.0.0.1:3101",
    viewport: { width: 1440, height: 1000 },
    headless: true,
    launchOptions: {
      executablePath: await chromium.executablePath(),
      args: [
        ...chromium.args.filter(
          (arg) =>
            ![
              "--single-process",
              "--disable-web-security",
              "--allow-running-insecure-content",
              "--disable-site-isolation-trials",
            ].includes(arg),
        ),
        "--disable-gpu",
      ],
      env: {
        ...process.env,
        XDG_CACHE_HOME: join(tmpdir(), "leafivo-browser-cache"),
      },
    },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run build && node server/index.js",
    url: "http://127.0.0.1:3101/api/health",
    reuseExistingServer: false,
    timeout: 60000,
    env: {
      PORT: "3101",
      NODE_ENV: "production",
      STORE_MODE: "preview",
      PUBLIC_PREVIEW: "false",
      OWNER_MANAGEMENT_ENABLED: "false",
      DATABASE_PATH: testDatabase,
      ADMIN_TOKEN: "leafivo-e2e-only-owner-token-not-for-production",
      PUBLIC_BASE_URL: "http://127.0.0.1:3101",
      STRIPE_SECRET_KEY: "",
      STRIPE_WEBHOOK_SECRET: "",
    },
  },
});
