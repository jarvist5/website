import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const API = "https://api.render.com/v1/";
export const PREVIEW = Object.freeze({
  name: "leafivo-preview",
  repo: "https://github.com/jarvist5/website",
  branch: "codex/leafivo-public-preview",
});
const activeStatuses = new Set([
  "created",
  "queued",
  "build_in_progress",
  "pre_deploy_in_progress",
  "update_in_progress",
]);
const terminalFailures = new Set([
  "build_failed",
  "pre_deploy_failed",
  "update_failed",
  "canceled",
  "deactivated",
]);

export class DeploymentPrerequisiteError extends Error {}

export function verifiedSourceCommit() {
  try {
    const options = {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 20000,
      stdio: ["ignore", "pipe", "pipe"],
    };
    const branch = execFileSync(
      "git",
      ["branch", "--show-current"],
      options,
    ).trim();
    const dirty = execFileSync(
      "git",
      ["status", "--porcelain=v1", "--untracked-files=all"],
      options,
    ).trim();
    const commit = execFileSync(
      "git",
      ["rev-parse", "--verify", "HEAD^{commit}"],
      options,
    ).trim();
    if (branch !== PREVIEW.branch || dirty || !/^[a-f0-9]{40}$/.test(commit))
      throw new Error("Source is not prepared");
    const remote = execFileSync(
      "git",
      ["ls-remote", PREVIEW.repo, `refs/heads/${PREVIEW.branch}`],
      options,
    )
      .trim()
      .split(/\s+/)[0];
    if (remote !== commit) throw new Error("Remote differs");
    return commit;
  } catch {
    throw new DeploymentPrerequisiteError(
      `Commit and push the clean ${PREVIEW.branch} branch to ${PREVIEW.repo} before deploying.`,
    );
  }
}

const sameRepo = (value) =>
  typeof value === "string" &&
  value.replace(/\.git$/, "").replace(/\/$/, "") === PREVIEW.repo;
const safePublicUrl = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      url.hostname.endsWith(".onrender.com")
      ? url.origin
      : null;
  } catch {
    return null;
  }
};
const safeDashboardUrl = (value) => {
  try {
    const url = new URL(value);
    return url.origin === "https://dashboard.render.com" &&
      !url.username &&
      !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
};

/** Deploy only the named free inspection service. No arbitrary API origin or paid-plan override. */
export async function deployRender({
  apiKey = process.env.RENDER_API_KEY,
  ownerId = process.env.RENDER_OWNER_ID,
  fetchImpl = globalThis.fetch,
  expectedCommit,
  statePath = resolve(ROOT, ".data/render-deployment.json"),
  pollMs = 3000,
  maxWaitMs = 30000,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  if (!apiKey)
    throw new DeploymentPrerequisiteError(
      "Render is not connected. Add RENDER_API_KEY securely in environment settings for api.render.com; never paste the key into chat.",
    );
  const commit = expectedCommit ?? verifiedSourceCommit();
  if (!/^[a-f0-9]{40}$/.test(commit))
    throw new DeploymentPrerequisiteError(
      "A verified full source commit is required.",
    );
  const request = async (path, { method = "GET", body } = {}) => {
    const url = new URL(path, API);
    if (
      url.origin !== "https://api.render.com" ||
      !url.pathname.startsWith("/v1/")
    )
      throw new Error("Unsupported deployment API destination.");
    let response;
    try {
      response = await fetchImpl(url, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(20000),
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${apiKey}`,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new Error(
        "Render could not be reached through the configured HTTPS route. No automatic retry was made.",
      );
    }
    if (!response.ok) {
      const advice =
        response.status === 401 || response.status === 403
          ? "Check the Render connection and workspace/repository access."
          : response.status === 402
            ? "Render requires billing/account action; no paid fallback will be selected."
            : response.status === 429
              ? "Render rate limited the request. Retry after the provider limit clears."
              : "Inspect the service in the Render dashboard before retrying.";
      throw new Error(
        `Render request failed (HTTP ${response.status}). ${advice}`,
      );
    }
    try {
      return await response.json();
    } catch {
      throw new Error(
        "Render returned an unexpected response. Inspect its dashboard before retrying.",
      );
    }
  };
  const list = async (path, key) => {
    const result = [];
    let cursor = "";
    const seen = new Set();
    for (let page = 0; page < 20; page++) {
      const url = new URL(path, API);
      url.searchParams.set("limit", "100");
      if (cursor) url.searchParams.set("cursor", cursor);
      const records = await request(url.href);
      if (!Array.isArray(records))
        throw new Error(
          "Render returned an unexpected list. No service was created.",
        );
      for (const record of records) {
        if (!record?.[key])
          throw new Error(
            "Render returned an incomplete list. No service was created.",
          );
        result.push(record[key]);
      }
      if (records.length < 100) return result;
      const next = records.at(-1)?.cursor;
      if (!next || seen.has(next))
        throw new Error(
          "Render pagination was incomplete. No service was created.",
        );
      seen.add(next);
      cursor = next;
    }
    throw new Error(
      "Render listing exceeded its safe bound. No service was created.",
    );
  };

  const owners = await list("owners", "owner");
  const owner = ownerId
    ? owners.find((item) => item.id === ownerId)
    : owners.length === 1
      ? owners[0]
      : null;
  if (!owner)
    throw new DeploymentPrerequisiteError(
      ownerId
        ? "The configured RENDER_OWNER_ID is not available to this connection."
        : "Select the intended Render workspace with RENDER_OWNER_ID; this connection has multiple or no workspaces.",
    );
  if (typeof owner.id !== "string" || !owner.id)
    throw new Error("Render returned an invalid workspace.");
  const services = await list(
    `services?ownerId=${encodeURIComponent(owner.id)}&name=${PREVIEW.name}`,
    "service",
  );
  const named = services.filter(
    (service) => service.name === PREVIEW.name && service.ownerId === owner.id,
  );
  if (named.length > 1)
    throw new Error(
      "Multiple matching services exist. Resolve the intended service in Render before retrying.",
    );
  let service = named[0],
    deployId,
    created = false;
  if (service) {
    if (
      service.type !== "web_service" ||
      !sameRepo(service.repo) ||
      service.branch !== PREVIEW.branch ||
      service.serviceDetails?.runtime !== "docker" ||
      service.serviceDetails?.plan !== "free" ||
      service.serviceDetails?.disk
    )
      throw new Error(
        "An existing service with this name does not match the free preview configuration. It was not changed.",
      );
    const env = await list(
      `services/${encodeURIComponent(service.id)}/env-vars`,
      "envVar",
    );
    const settings = Object.fromEntries(
      env.map((item) => [item.key, item.value]),
    );
    if (settings.PUBLIC_PREVIEW !== "true" || settings.STORE_MODE !== "preview")
      throw new Error(
        "The existing service is not explicitly configured as a public preview. It was not changed.",
      );
    const latest = await list(
      `services/${encodeURIComponent(service.id)}/deploys`,
      "deploy",
    );
    const current = latest[0];
    if (current?.commit?.id === commit) {
      if (terminalFailures.has(current.status))
        throw new Error(
          `The existing deploy is ${current.status}. Inspect the Render dashboard and resolve the failure before retrying.`,
        );
      deployId = current.id;
    } else {
      const deployment = await request(
        `services/${encodeURIComponent(service.id)}/deploys`,
        {
          method: "POST",
          body: { clearCache: "do_not_clear", commitId: commit },
        },
      );
      deployId = deployment.id;
    }
  } else {
    const envVars = Object.entries({
      NODE_ENV: "production",
      STORE_NAME: "Leafivo",
      STORE_MODE: "preview",
      PUBLIC_PREVIEW: "true",
      ADMIN_TOKEN: "",
      STRIPE_SECRET_KEY: "",
      STRIPE_WEBHOOK_SECRET: "",
      DATABASE_PATH: "/app/.data/store.sqlite",
      DOWNLOAD_DIR: "/app/private-downloads",
    }).map(([key, value]) => ({ key, value }));
    const result = await request("services", {
      method: "POST",
      body: {
        type: "web_service",
        name: PREVIEW.name,
        ownerId: owner.id,
        repo: PREVIEW.repo,
        branch: PREVIEW.branch,
        autoDeployTrigger: "off",
        envVars,
        serviceDetails: {
          runtime: "docker",
          plan: "free",
          region: "oregon",
          healthCheckPath: "/api/health",
          envSpecificDetails: {
            dockerfilePath: "./Dockerfile",
            dockerContext: ".",
          },
        },
      },
    });
    service = result.service;
    deployId = result.deployId;
    created = true;
    if (!service?.id)
      throw new Error(
        "Render did not return a service ID. Inspect the dashboard before retrying.",
      );
    if (!deployId) {
      const latest = await list(
        `services/${encodeURIComponent(service.id)}/deploys`,
        "deploy",
      );
      deployId = latest[0]?.id;
    }
  }
  if (!deployId)
    throw new Error(
      "Render has not returned a deployment ID. Inspect the dashboard before retrying.",
    );
  if (
    service.type !== "web_service" ||
    !sameRepo(service.repo) ||
    service.branch !== PREVIEW.branch ||
    service.ownerId !== owner.id ||
    service.serviceDetails?.runtime !== "docker" ||
    service.serviceDetails?.plan !== "free" ||
    service.serviceDetails?.disk
  )
    throw new Error(
      "Render returned an unexpected service configuration. Inspect its dashboard before continuing.",
    );
  const save = (status, metadata = {}) => {
    const result = {
      name: PREVIEW.name,
      branch: PREVIEW.branch,
      commit,
      serviceId: service.id,
      deployId,
      status,
      created,
      live: status === "live",
      applicationValidated: false,
      url: safePublicUrl(service.serviceDetails?.url),
      dashboardUrl: safeDashboardUrl(service.dashboardUrl),
      ...metadata,
    };
    mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });
    writeFileSync(statePath, JSON.stringify(result, null, 2) + "\n", {
      mode: 0o600,
    });
    return result;
  };
  save("created");
  const deadline = now() + Math.max(0, Math.min(maxWaitMs, 30000));
  do {
    const deployment = await request(
      `services/${encodeURIComponent(service.id)}/deploys/${encodeURIComponent(deployId)}`,
    );
    if (deployment.commit?.id && deployment.commit.id !== commit)
      throw new Error(
        "Render is building a different source commit. No readiness claim was made.",
      );
    const status = deployment.status;
    if (status === "live") {
      if (deployment.commit?.id !== commit)
        throw new Error(
          "Render did not confirm the expected source commit. No readiness claim was made.",
        );
      service = await request(`services/${encodeURIComponent(service.id)}`);
      if (
        service.type !== "web_service" ||
        !sameRepo(service.repo) ||
        service.branch !== PREVIEW.branch ||
        service.ownerId !== owner.id ||
        service.serviceDetails?.runtime !== "docker" ||
        service.serviceDetails?.plan !== "free" ||
        service.serviceDetails?.disk
      )
        throw new Error(
          "The live service no longer matches the intended free preview. Inspect its dashboard.",
        );
      if (!safePublicUrl(service.serviceDetails?.url))
        throw new Error(
          "Render reports live but returned no verified onrender.com HTTPS origin. Inspect its dashboard.",
        );
      return save("live");
    }
    if (terminalFailures.has(status)) {
      save(status);
      throw new Error(
        `Render deploy is ${status}. Inspect the Render dashboard; no paid fallback or unchanged automatic retry was attempted.`,
      );
    }
    if (!activeStatuses.has(status))
      throw new Error(
        "Render returned an unknown deploy state. No readiness claim was made.",
      );
    const result = save(status);
    if (now() >= deadline) return result;
    await sleep(Math.min(pollMs, Math.max(0, deadline - now())));
  } while (true);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const result = await deployRender();
    console.log(JSON.stringify(result, null, 2));
    if (result.live)
      console.log(
        "Render reports the expected source deploy is live. Public application/browser validation remains required.",
      );
    if (!result.live)
      console.log(
        "Deployment is still running. No public readiness claim has been made; rerun the command to check the existing deploy.",
      );
  } catch (error) {
    console.error(error.message);
    process.exitCode = error instanceof DeploymentPrerequisiteError ? 2 : 1;
  }
}
