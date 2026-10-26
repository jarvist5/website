# Security review and launch controls

Review date: **2026-10-26**. Scope: this application's source, dependency audit, and local automated checks. This is not an independent penetration test, a review of a deployed host, a guarantee against attacks, or a legal certification.

## Implemented and locally tested controls

The local source review and automated regression tests verify the following behavior:

- Production security headers restrict scripts/resources to the store, block framing and embedded objects, suppress referrers, and deny unneeded browser permissions. Development tooling needs separate treatment; never expose the Vite development server as the public production host.
- State-changing browser requests have origin controls. Server-side validation limits input types, lengths, quantities, and monetary totals. Bounded rate limiting reduces repeated requests; it does not replace hosting-level abuse protection.
- Private configuration, database, source, and download paths are denied through the public application. Paid files stay outside the web root, with path and symlink confinement. Startup rejects database/download settings that overlap public asset directories, including through existing symlinks.
- Prices come from the server catalog. A payment redirect never proves payment; only a verified, matching payment event unlocks a purchase.
- Receipt capabilities move in a return-URL fragment, then an authorization header, rather than query strings. They expire after 24 hours. Signed download links expire after one hour. Tokens are hashed before database storage, including migration of legacy rows. Treat receipt and download capabilities as private credentials; redact authorization headers and signed download query strings in application, proxy, CDN and hosting logs.
- Verified full refunds and disputes revoke future download access. Access remains revoked until an owner manually reconciles the case; a repeated payment event must not reactivate it. Revocation cannot retrieve files a customer already downloaded.
- The admin credential stays in browser memory, not local storage. An inactivity timer clears owner data after 15 minutes, and leaving the page clears it too; this does not revoke the server key. Product/customer text is rendered through React as text. No third-party advertising trackers are installed in the preview.

## Evidence and limits

`npm audit --json` reported **0 known dependency advisories** on the review date, across production and development dependencies. This is a time-specific registry result, not proof that dependencies contain no vulnerabilities.

Validation completed locally:

| Check              | Result                         |
| ------------------ | ------------------------------ |
| `npm test`         | 58 passed; 0 failures or skips |
| `npm run test:e2e` | 15 passed; 0 failures or skips |
| `npm run build`    | Production build passed        |
| Dependency audit   | 0 known advisories             |

Regression checks cover server pricing, authentication, hostile origins, CSP headers, oversized input, private paths/storage settings, token hashing/expiry, signed payment/refund/dispute events, late event replay, stored text injection, receipt credential isolation, and the shopping/management workflows. Browser tests detected no uncaught exceptions or CSP violations. Receipt UI states use mocked API responses; signed webhook tests use local test signatures. No real payment or deployed-host penetration test was performed.

Known operational limits: rate limits are per process and reset on restart; use an edge/shared limiter for public deployments. Partial refunds retain order entitlement and need manual reconciliation; dashboard paid-order totals are not net accounting revenue. Dispute access stays on hold until verified manual reconciliation. Legacy paid orders without a payment-intent mapping require reconciliation against the provider; migration does not invent that mapping. Files already downloaded cannot be revoked. HTTPS, proxy behavior, real-provider webhooks, data deletion and backup restoration still require checks on the final host.

## Required before real sales

1. **Protect the owner account.** Use a unique, cryptographically random `ADMIN_TOKEN` of at least 24 characters, entered through secure environment configuration. Rotate it after suspected exposure. This starter uses a static bearer key; signing out clears browser state but does not revoke that server key. Put the owner interface/API behind an identity gateway with MFA, or implement equivalent authenticated sessions, before a public launch. Do not put credentials in URLs, Git, screenshots, or social posts.
2. **Secure hosting and data.** Run the production server behind verified HTTPS. Set proxy trust only for the real deployment topology. Use restricted OS access and encrypted storage/backups for customer data and private files. Keep credentials outside the public web root, restrict logs, monitor failures, and test restoration. Apply host-level rate/size limits and security updates. Do not expose database files or raw backup archives.
3. **Verify payments and delivery.** The Pakistan-based owner still needs an approved provider and tested integration. Safepay is a candidate, not an installed option; the optional Stripe path does not establish merchant eligibility. Test payment, failure, cancellation, duplicate events, refund/dispute revocation, and file delivery with the chosen provider. Email receipts, delivery email, and account-based recovery are not implemented; establish a support/recovery process before accepting money.
4. **Set a data policy.** Identify the operator and privacy contact, explain collection/retention, define an executable deletion process, and decide which records must be retained for legal obligations. Consent-based signups are stored, but email sending and unsubscribe management are not connected. Do not send campaigns until that workflow is complete.
5. **Verify the actual products.** Sell content you own or are licensed to distribute. Check files for malware, verify all claims and examples, and state formats, licenses, delivery, support, and applicable refund/cancellation rights accurately. Educational purpose does not replace copyright permission, consumer rights, tax obligations, privacy duties, or payment-provider requirements. Use qualified local advice for the countries you serve; this repository does not supply completed legal policies.

## If an incident occurs

Restrict affected access, rotate exposed credentials, preserve relevant evidence without sharing customer data, and stop affected live checkout/download operations while investigating. Check the payment provider and hosting logs through their authorized tools. Follow applicable customer notification and legal duties. Do not post credentials, receipt links, private files, or customer details in a public issue.

## Public inspection mode

`PUBLIC_PREVIEW=true` is only allowed with `STORE_MODE=preview`. It disables all owner APIs, email signup and delivery, receipt/download capabilities, and practice-order persistence. Practice checkout requires no email, and unsolicited submitted email addresses are not stored. Public preview pages send `X-Robots-Tag: noindex, nofollow`. The bag and favorites still use browser storage, and the hosting provider may retain ordinary request logs. This permits inspecting the sample store while real-business operations remain unfinished.
