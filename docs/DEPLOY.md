# Deploy the Leafivo public preview

The deployment files prepare a public **inspection preview**, using sample products and no real payments. A successful local build is not a published website. The live service URL is only established after the hosting provider creates a service and the deployed site passes its checks.

The preview is designed for browsing, product details, search, favorites, bag controls, a non-persistent sample checkout, and draft social assets. With `PUBLIC_PREVIEW=true`, newsletter collection and owner APIs are disabled, checkout collects no email, and sample orders/customer information are not persisted. Keep both `STORE_MODE=preview` and `PUBLIC_PREVIEW=true` while inspecting the site.

## Render preview

The repository includes [render.yaml](../render.yaml) for a free Render Docker web service. It does not request a paid plan or persistent disk. Render account eligibility, free-tier limits and availability are controlled by Render and can change; review any provider prompts before creating paid resources.

1. Sign in to your Render account and connect the GitHub repository `jarvist5/website`. The deployment branch is `codex/leafivo-public-preview`. Confirm the prepared files have been pushed to that branch; local uncommitted changes are not accessible to Render.
2. Create a Blueprint from that repository and select `codex/leafivo-public-preview`, which contains `render.yaml`. Review the proposed **free** `leafivo-preview` web service. Do not add payment credentials or an admin access key for this public preview.
3. Let Render build the Docker image. The service health endpoint is `/api/health`. The backend accepts Render's assigned `PORT`; the blueprint supplies 3001 as a default.
4. Open the HTTPS URL that Render assigns. Render supplies `RENDER_EXTERNAL_URL`, which the application uses as the validated public origin unless `PUBLIC_BASE_URL` is explicitly set. If a custom domain is added later, set `PUBLIC_BASE_URL` to its exact HTTPS origin, with no path, query, credentials or fragment.
5. Run the deployed checks below. Record the actual HTTPS URL only after it responds correctly.

Render's free service can sleep when idle and has temporary storage. Sample catalog edits and other local files may disappear on restart or redeployment. The public preview intentionally does not collect customer information, so it does not need a persistent disk. This preview is not an operating sales system.

### Deploy through an authorized hosting API

An agent can create the same free service through Render's API only after the user supplies an authorized Render API connection through secure environment settings. Use the connected account's correct owner/workspace and the existing repository; never invent account IDs, billing details or credentials. If secure configuration is unavailable, finish local validation and identify that precise blocker. Never request or paste an API key in chat, source files, URLs, screenshots, build arguments or logs.

### Automated deployment command

The prepared checkout includes:

```sh
npm run deploy:render
```

It requires a secure `RENDER_API_KEY` binding for `api.render.com`, and a clean committed/pushed `codex/leafivo-public-preview` branch. If the connection has several workspaces, select the intended one with `RENDER_OWNER_ID`; it never guesses a workspace. It creates only the named free preview with no paid disk, refuses unrelated or paid services, and reuses the same existing deployment when safe. Status is saved without credentials in `.data/render-deployment.json`. A provider-reported live status still requires the public checks below. Rerunning while a build is in progress checks that build instead of creating another service.

The real command was exercised without a key and stopped before making any external request. No Render service or public website URL has been created in this session. Enter keys only through secure environment settings, never through chat. The environment draft includes a `RENDER_API_KEY` requirement; adding that requirement does not supply its value or apply the connection. Review/save the relevant environment settings and publish the environment configuration when prompted.

## Local production container

Requires Docker with access to the official Node image and npm registry:

```sh
docker build -t leafivo-preview .
docker run --rm --name leafivo-preview -p 3001:3001 leafivo-preview
```

The image uses pinned Node 24.19.0, builds the Vite frontend, retains production dependencies only, and runs the application as the unprivileged `node` user. Its writable data and private-download directories are outside the public assets, owned by that user, and restricted to that user. The build context excludes local secrets, databases, paid files, Git metadata and test artifacts. No local `.env` is copied into the image. Managed development networks may require their existing proxy route and trusted CA during a local build; the Dockerfile accepts an optional build-only `platform_ca` secret for that trust file. It does not save the certificate in an image layer and never disables TLS verification. Normal Render builds do not require that local secret.

For internal validation, make a request to the mapped health endpoint and homepage. Stop only containers you started. An image, container ID or listening port alone does not prove the deployed workflows work.

## Local deployment validation

The Docker production build passed in this workspace. A temporary container then passed functional checks as UID 1000 with a read-only root filesystem and writable, restricted private directories: homepage and CSP, six sample listings, non-persistent checkout without email, disabled signup/owner APIs, private-path denial, and zero saved orders or subscribers. The runtime contained neither local `.env` files, the optional build trust file, nor Vite development tooling. The temporary container was removed after validation.

These checks validate the container, not a public hosting service. The assigned Render domain, TLS and the actual deployed site still need verification after service creation.

## Check the actual public deployment

- The homepage responds over HTTPS, shows Leafivo and clearly labels the sample/preview status.
- Product details, category filters, search, favorites, cart updates and mobile navigation work.
- Sample checkout does not ask for an email, take a payment or persist customer/order information.
- Newsletter signup is unavailable and does not store an address. Owner APIs are unavailable in public-preview mode.
- The health API reports preview mode and public preview. No payment provider is connected.
- Production CSP, anti-framing, no-referrer and other security headers are present; browser checks show no unexpected script or CSP errors.
- Requests for `/.env`, `/.data/store.sqlite`, `/server/index.js` and `/private-downloads/` do not disclose private content.
- The assigned origin matches the deployment URL. Do not guess reverse-proxy hop counts; verify the provider topology before setting `TRUST_PROXY_HOPS` or relying on forwarded client addresses.

Use the actual Render URL supplied by Render. Do not advertise an invented domain, a loopback address, or an unfinished deployment as a public store.

## Before real business operations

The free preview configuration is deliberately limited. Real sales need the owner's real products, completed business policies and contact details, a provider approved for the Pakistan-based business and tested integration, reliable delivery/recovery, stronger owner authentication, and protected persistent customer/order storage. Approve any hosting budget before moving to a paid plan or persistent disk. A managed database requires an application adapter; this application currently uses SQLite.

Do not merely switch the free preview to live payments. Follow [the go-live checklist](GO-LIVE.md) and [security review](SECURITY.md), test real-provider behavior on the final host, and validate backups/restoration. For a persistent Node/SQLite service, mount private storage outside the public web root and set `DATABASE_PATH` and `DOWNLOAD_DIR` to those secured paths. Images do not contain paid product files; provision owned files separately through the authorized host storage workflow.
