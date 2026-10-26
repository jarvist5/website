import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deployRender, PREVIEW } from "../scripts/deploy-render.mjs";
const commit = "a".repeat(40);
const service = {
  id: "srv-test-preview",
  name: PREVIEW.name,
  ownerId: "tea-test",
  type: "web_service",
  repo: PREVIEW.repo,
  branch: PREVIEW.branch,
  dashboardUrl: "https://dashboard.render.com/web/srv-test-preview",
  serviceDetails: {
    runtime: "docker",
    plan: "free",
    url: "https://leafivo-example.onrender.com",
  },
};
const response = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
function fixture(t, handler) {
  const dir = mkdtempSync(join(tmpdir(), "render-script-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const calls = [];
  return {
    statePath: join(dir, "status.json"),
    calls,
    options: {
      apiKey: "test-render-connection-not-a-real-key",
      expectedCommit: commit,
      statePath: join(dir, "status.json"),
      sleep: async () => {},
      maxWaitMs: 0,
      fetchImpl: async (url, init) => {
        calls.push({ url: new URL(url), init });
        assert.equal(new URL(url).origin, "https://api.render.com");
        assert.equal(init.redirect, "error");
        assert.equal(
          init.headers.Authorization,
          "Bearer test-render-connection-not-a-real-key",
        );
        return handler(new URL(url), init);
      },
    },
  };
}
function standard(url, init) {
  if (url.pathname === "/v1/owners")
    return response([
      {
        owner: {
          id: "tea-test",
          name: "My workspace",
          email: "owner@example.com",
        },
      },
    ]);
  if (url.pathname === "/v1/services" && init.method === "GET")
    return response([]);
  if (url.pathname === "/v1/services" && init.method === "POST")
    return response({ service, deployId: "dep-test" }, 201);
  if (url.pathname.endsWith("/deploys/dep-test"))
    return response({ id: "dep-test", status: "live", commit: { id: commit } });
  if (url.pathname === "/v1/services/srv-test-preview")
    return response(service);
  throw new Error("Unexpected test request");
}

test("missing Render connection never performs network requests or source actions", async () => {
  let calls = 0;
  await assert.rejects(
    deployRender({
      apiKey: "",
      fetchImpl: async () => {
        calls++;
      },
    }),
    /Add RENDER_API_KEY securely/,
  );
  assert.equal(calls, 0);
});

test("creates only the requested free public-preview Docker service and stores no credentials", async (t) => {
  const f = fixture(t, standard);
  const result = await deployRender(f.options);
  assert.equal(result.live, true);
  assert.equal(result.url, "https://leafivo-example.onrender.com");
  const create = f.calls.find((c) => c.init.method === "POST");
  const body = JSON.parse(create.init.body);
  assert.equal(body.serviceDetails.plan, "free");
  assert.equal(body.serviceDetails.runtime, "docker");
  assert.ok(!body.serviceDetails.disk);
  assert.equal(body.branch, PREVIEW.branch);
  assert.equal(body.repo, PREVIEW.repo);
  assert.equal(body.autoDeployTrigger, "off");
  const env = Object.fromEntries(
    body.envVars.map(({ key, value }) => [key, value]),
  );
  assert.equal(env.PUBLIC_PREVIEW, "true");
  assert.equal(env.STORE_MODE, "preview");
  assert.equal(env.ADMIN_TOKEN, "");
  assert.equal(env.STRIPE_SECRET_KEY, "");
  assert.equal(body.serviceDetails.healthCheckPath, "/api/health");
  const state = readFileSync(f.statePath, "utf8");
  assert.ok(
    !state.includes("test-render-connection") &&
      !state.includes("owner@example.com"),
  );
  assert.equal(JSON.parse(state).status, "live");
});

test("multiple workspaces require explicit selection before any service creation", async (t) => {
  const f = fixture(t, (url) => {
    assert.equal(url.pathname, "/v1/owners");
    return response([
      { owner: { id: "tea-one" } },
      { owner: { id: "tea-two" } },
    ]);
  });
  await assert.rejects(
    deployRender(f.options),
    /Select the intended Render workspace/,
  );
  assert.equal(f.calls.length, 1);
});

test("an unrelated or paid same-name service is never modified or redeployed", async (t) => {
  const f = fixture(t, (url, init) =>
    url.pathname === "/v1/owners"
      ? standard(url, init)
      : response([
          {
            service: {
              ...service,
              serviceDetails: { ...service.serviceDetails, plan: "starter" },
            },
          },
        ]),
  );
  await assert.rejects(
    deployRender(f.options),
    /does not match the free preview/,
  );
  assert.ok(f.calls.every((c) => c.init.method === "GET"));
});

test("rechecking the same live preview commit is idempotent and creates no service/deploy", async (t) => {
  const f = fixture(t, (url, init) => {
    if (url.pathname === "/v1/services" && init.method === "GET")
      return response([{ service }]);
    if (url.pathname.endsWith("/env-vars"))
      return response([
        { envVar: { key: "PUBLIC_PREVIEW", value: "true" } },
        { envVar: { key: "STORE_MODE", value: "preview" } },
      ]);
    if (url.pathname.endsWith("/deploys"))
      return response([
        { deploy: { id: "dep-test", status: "live", commit: { id: commit } } },
      ]);
    return standard(url, init);
  });
  const result = await deployRender(f.options);
  assert.equal(result.created, false);
  assert.equal(result.live, true);
  assert.ok(f.calls.every((c) => c.init.method === "GET"));
});

test("an existing service without public preview safeguards is not changed", async (t) => {
  const f = fixture(t, (url, init) => {
    if (url.pathname === "/v1/services") return response([{ service }]);
    if (url.pathname.endsWith("/env-vars"))
      return response([{ envVar: { key: "STORE_MODE", value: "live" } }]);
    return standard(url, init);
  });
  await assert.rejects(
    deployRender(f.options),
    /not explicitly configured as a public preview/,
  );
  assert.ok(f.calls.every((c) => c.init.method === "GET"));
});

test("building is saved as pending instead of claiming the URL is ready", async (t) => {
  const f = fixture(t, (url, init) =>
    url.pathname.endsWith("/deploys/dep-test")
      ? response({
          id: "dep-test",
          status: "build_in_progress",
          commit: { id: commit },
        })
      : standard(url, init),
  );
  const result = await deployRender(f.options);
  assert.equal(result.live, false);
  assert.equal(result.status, "build_in_progress");
  assert.equal(JSON.parse(readFileSync(f.statePath)).live, false);
});

test("billing or authentication errors never select a paid fallback or echo provider bodies", async (t) => {
  for (const status of [401, 402]) {
    const f = fixture(t, () =>
      response({ message: "secret-provider-body-never-log" }, status),
    );
    await assert.rejects(
      deployRender(f.options),
      (error) =>
        error.message.includes(`HTTP ${status}`) &&
        !error.message.includes("secret-provider-body"),
    );
    assert.equal(f.calls.length, 1);
  }
});

test("a provider deploy for another source commit is never declared ready", async (t) => {
  const f = fixture(t, (url, init) =>
    url.pathname.endsWith("/deploys/dep-test")
      ? response({
          id: "dep-test",
          status: "live",
          commit: { id: "b".repeat(40) },
        })
      : standard(url, init),
  );
  await assert.rejects(deployRender(f.options), /different source commit/);
  assert.equal(JSON.parse(readFileSync(f.statePath)).live, false);
});

test("a live state without the expected commit or a valid public URL is not saved as ready", async (t) => {
  for (const variant of ["missing-commit", "invalid-url"]) {
    const f = fixture(t, (url, init) => {
      if (
        variant === "missing-commit" &&
        url.pathname.endsWith("/deploys/dep-test")
      )
        return response({ id: "dep-test", status: "live" });
      if (
        variant === "invalid-url" &&
        url.pathname === "/v1/services/srv-test-preview"
      )
        return response({
          ...service,
          serviceDetails: {
            ...service.serviceDetails,
            url: "http://untrusted.example",
          },
        });
      return standard(url, init);
    });
    await assert.rejects(
      deployRender(f.options),
      /No readiness claim|no verified onrender/,
    );
    assert.equal(JSON.parse(readFileSync(f.statePath)).live, false);
  }
});
