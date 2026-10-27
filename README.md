# Leafivo

An independent digital storefront for ebooks, templates, and bundles, with USD prices. Leafivo is a **working brand** ("leaf-ee-voh"); domain and trademark clearance have not been completed.

## Develop

Requires Node.js 24 (uses built-in SQLite) and npm.

```sh
npm ci --cache /tmp/leafivo-npm-cache
cp .env.example .env
npm run dev
```

The frontend uses port 5173 and proxies `/api` to the backend on port 3001. Preview mode is the default. Six sample products are seeded once. All product covers and social graphics are generated locally; fonts are bundled.

Production owner access uses a private one-time activation link, a password you choose, and a mandatory authenticator code. Sessions use HttpOnly, SameSite=Strict cookies and CSRF protection; logout revokes them on the server. Recovery codes support lost-phone recovery, and account security settings let you change your password or replace your authenticator. See [owner setup](docs/OWNER-SETUP.md).

The production owner feature stays disabled on the free preview. Enabling it requires verified permanent storage, `OWNER_MANAGEMENT_ENABLED=true`, `OWNER_STORAGE_PERSISTENT=true`, a stable private `OWNER_AUTH_KEY`, and an expiring `OWNER_SETUP_TOKEN`/`OWNER_SETUP_EXPIRES`. Keep these values out of source. A setup link creates exactly one owner; the owner chooses the password privately. The legacy `ADMIN_TOKEN` flow is only for local development and is refused in production. Paid download signing uses a separate `DOWNLOAD_SIGNING_KEY`.

```sh
npm run build
npm start
```

Production serves the built frontend and API together on `PORT` (3001 by default). Use a persistent disk for `.data/store.sqlite` and `private-downloads/`, a reverse proxy with HTTPS, and backups. This app is not suitable for a static-only host or ephemeral serverless filesystem. Set `TRUST_PROXY_HOPS` only to the actual number of trusted reverse-proxy hops. Environment settings are listed in [.env.example](.env.example).

## What works

- Responsive storefront, product detail links, category filters, search, sorting, favorites, and a persistent bag.
- Server-priced preview checkout: records a clearly unpaid sample order and never charges a card.
- Persistent consented newsletter signups; **does not send email**.
- Password-and-authenticator protected owner dashboard with product creation/editing/removal, order history, signup counts, private PDF/EPUB/ZIP uploads (25 MB), password changes and authenticator recovery. Deployment activation is gated on permanent storage.
- Product-specific draft captions for seven social channels and downloadable square artwork. **Nothing is posted and no ad spend occurs.**
- Optional Stripe hosted checkout, signature-verified webhooks, and expiring paid-download links. This adapter is tested with simulated payment events, **not a real merchant account**.

A product can only lose its sample label once its real owned file exists in the private downloads directory. That file is never served publicly. Product share links use `/#product/<id>`.

## Public preview deployment

See [Render deployment instructions](docs/DEPLOY.md). The Docker image and Render blueprint default to `STORE_MODE=preview` and `PUBLIC_PREVIEW=true`: no payments, no saved orders, no email collection, and no owner API access by default. An explicitly enabled, durably hosted owner account can manage products while the customer side remains in preview. This mode is for public inspection of the design and shopping flow. Local development retains private management and saved sample orders unless you set `PUBLIC_PREVIEW=true`.

Render supplies `RENDER_EXTERNAL_URL` as the trusted public origin when `PUBLIC_BASE_URL` is unset. The free preview filesystem is temporary. Real selling requires an approved payment integration, persistent storage, operational/legal setup, and a separate launch decision. The deployment helper reads `RENDER_API_KEY` from secure environment configuration; never put the key in source or chat.

## Payments and global sales

**The owner is based in Pakistan. Stripe is not a confirmed eligible payment solution for this business. Keep `STORE_MODE=preview`.** Investigate Safepay merchant approval and confirm current international-card support, USD pricing and settlement, refunds, and fees. A Safepay adapter is **not yet implemented**. Another approved provider also needs its own verified integration. Visa, Mastercard, UnionPay, wallets, and all-country acceptance cannot be promised without provider approval and testing.

Only an independently eligible Stripe merchant should use the included Stripe live path. It requires `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, a configured secure owner account, a private `DOWNLOAD_SIGNING_KEY`, `PUBLIC_BASE_URL` with HTTPS, and `STORE_MODE=live`. Configure `/api/webhooks/stripe` for `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `charge.refunded`, and `charge.dispute.created`. Test with the provider's test account before real sales. Live mode blocks sample products and missing private files. A checkout redirect alone never unlocks downloads.

The payment return view verifies order status and offers paid downloads. Receipt capabilities expire after 24 hours, are hashed in the database, and travel through the return URL fragment and API authorization headers. Download links expire in one hour. Verified full refunds and disputes revoke future downloads, including previously issued links; payment replays cannot restore that access. Partial refunds require manual reconciliation. Receipt/delivery email and account-based download recovery are **not implemented**; complete a reliable recovery/support flow before accepting real orders. Do not log authorization headers, signed download query strings, or share private receipt/download URLs.

Physical inventory, shipping, tax automation, finished legal policies, social account integrations, and advertising tracking are not implemented. Do not market physical fulfillment or enable paid campaigns until the required business operations are ready.

## Validation

```sh
npm test
npm run build
npm run test:e2e
```

Backend tests cover authoritative pricing, validation, admin access, newsletter consent, persistence, webhook authenticity and payment matching, and private download confinement. Browser tests use isolated databases and disposable owner credentials; no real owner account is claimed by the tests. Playwright can use the npm-packaged Chromium binary on Linux; no global browser installation is required.

See [the go-live checklist](docs/GO-LIVE.md) and [the social launch plan](docs/SOCIAL-LAUNCH.md) for the decisions and external account setup still required.

## Security and educational use

The hardened production app includes a restrictive Content Security Policy, anti-framing and referrer protections, same-origin write checks, bounded request throttling, input limits, and startup checks that prevent customer databases or paid files being placed under public asset directories. Never expose Vite as the production server. HTTPS/proxy configuration, encrypted restricted backups, monitoring and MFA need validation on the actual host.

See [the security review](docs/SECURITY.md) for tested controls and remaining production limitations. Educational products still require distribution rights, accurate descriptions and suitable privacy, refund and tax practices. The preview policies are not completed legal documents.
