# Leafivo: owner launch checklist

Leafivo (pronounced “leaf-ee-voh”) is the working brand. Domain, business-name, and trademark availability have not been verified. The catalog contains sample products. A working storefront and a preview checkout do not create a registered business, connect a payment account, publish advertising, or establish any sales.

## 1. Make the store yours

- Confirm Leafivo as your trading name, logo, support email, and legal country of business. Check domain, business-name, and trademark availability before investing in the brand.
- The current catalog is priced in **US dollars**. The intended audience includes **Pakistan, Uzbekistan, the United States, and India**, with a broader global audience where you can lawfully sell and receive payment. Customer location does not establish your eligibility for a merchant account. Confirm any selling restrictions, local consumer requirements, taxes and card acceptance with your provider.
- Replace every sample listing with a product you own or have permission to sell. Check the title, description, price, file format, page count, license, and cover against the actual file.
- Keep paid digital files in the configured private downloads directory, never in the public assets directory. Associate each digital product with the correct file using the protected management API. Download a copy yourself before launching.
- Clearly state what buyers receive and what devices or software they need. Disclose recurring charges if you introduce them; the starter catalog is for one-time purchases.
- Confirm delivery and stock handling before listing physical products. The initial workflow centers on digital goods; shipping labels, carrier fulfillment, inventory reservations, and physical returns need a separate integration before you promise them.

## 2. Make business decisions

Prepare policies that reflect how you actually operate. Requirements vary by where you and your customers are located; check the rules for your intended markets before launch.

| Decision                  | What the published policy needs to explain                                                                                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Customer support          | Business identity and contact details, response times, help with damaged or missing files.                                                                                                  |
| License                   | Personal or commercial use, sharing restrictions, and any allowed number of users or devices.                                                                                               |
| Refunds and cancellations | Conditions and procedure, including any mandatory consumer rights. “Digital” does not automatically remove refund obligations.                                                              |
| Digital delivery          | When and how access is provided, link expiry, and how buyers request access again.                                                                                                          |
| Privacy                   | What contact and order data you collect, why you retain it, processors, retention periods, and how users exercise applicable rights.                                                        |
| Email marketing           | Consent, sender identity, and a working unsubscribe process. Collecting a subscriber is separate from sending campaigns.                                                                    |
| Tax                       | Registration obligations, tax-inclusive or exclusive pricing, VAT/sales tax on digital goods, invoices, and accounting records. The starter checkout does not establish your tax treatment. |
| Physical goods, if added  | Eligible destinations, delivery charges and estimates, customs, tracking, returns, and stock availability.                                                                                  |

Educational products must still comply with copyright permissions, accurate advertising, privacy duties, consumer rights, and applicable tax rules. State only rights and permissions you actually hold. Complete policies for your real business and markets; a general educational-use statement is not a legal certification.

Do not publish fabricated reviews, unsupported outcome claims, or scarcity messages that are not true. Do not upload bought email lists.

## 3. Connect and test payments

**For a Pakistan-based business, investigate Safepay merchant approval first.** Safepay's [official WooCommerce plugin FAQ](https://raw.githubusercontent.com/getsafepay/safepay-woocommerce/master/readme.txt) describes Pakistan merchant support, Visa/Mastercard, and USD/PKR, and its [official Node SDK](https://www.npmjs.com/package/@sfpy/node-sdk) provides hosted-checkout integration. These sources do not establish that your business is approved or that every current card or settlement option is available. Confirm current international-card acceptance, USD presentment versus settlement currency, fees, bank payouts, refunds, disputes, and merchant eligibility directly with Safepay before committing. The plugin FAQ may reflect older terms. **Safepay is not integrated into this project yet**; its checkout, signature verification, order reconciliation, and paid-file delivery require a separate implementation and test pass. Setting Stripe credentials or switching `STORE_MODE` cannot activate Safepay.

The existing adapter is **Stripe only**, for a merchant that is legitimately eligible for its services. The following steps apply to that adapter after eligibility is established:

1. Confirm your legal merchant country and payment-provider eligibility first. You can use Stripe only if it supports your actual business location and business type. Customer markets such as Pakistan, Uzbekistan, the United States, and India have different payment and regulatory conditions. If your business is ineligible for Stripe, keep the store in preview mode and use the eligible-provider integration route above before accepting money.
2. Set a strong `ADMIN_TOKEN` of at least 24 random characters in secure environment settings. Restrict it to the owner; never place it in a public URL or client source code.
3. Use Stripe **test mode** credentials first. Configure `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and your HTTPS `PUBLIC_BASE_URL` through the hosting provider's secrets settings. The API receives signed events at `/api/webhooks/stripe`; follow the server documentation for the supported events.
4. Replace sample products, attach the correct private files, and switch `STORE_MODE` to `live` for the test checkout. “Live” here enables hosted checkout; whether money is real depends on the Stripe keys. Keep test and real credentials separate.
5. Exercise a successful test payment, canceled checkout, declined payment, and repeated webhook event. Confirm that the amount comes from the server catalog and that downloads are available only after verified payment. Check the actual delivery path before promising email delivery.
6. Verify that full refunds and disputes revoke future downloads, including previously issued links. Keep revoked orders locked until you manually reconcile the case; repeated payment events must not reactivate them. Already-downloaded files cannot be retrieved. Connect any missing fulfillment, invoicing, and tax tools your business requires.
7. Only after the test checklist passes, substitute the live Stripe credentials and live webhook secret, then perform a small real purchase and refund under your own account.

Create or connect your own eligible business account and complete identity and bank verification before live operation. Card brands and payment methods depend on your merchant country, customer location, currency, provider configuration, issuer, and risk checks. **All cards and all countries are not guaranteed.** Verify Visa, Mastercard, American Express, UnionPay, local cards, and any wallets you want with the processor before displaying acceptance logos. A USD price does not guarantee that a local card can pay; issuers may decline cross-border purchases or apply conversion charges. Test the supported payment flow for the intended markets without making unsupported promises.

Do not paste keys into chat, Git, screenshots, analytics, or social posts. A browser redirect alone is not proof of payment; rely on the verified payment event.

## 4. Deploy the store

Complete the [security controls and deployment verification](SECURITY.md) before public selling. Source-level hardening and local tests do not establish that the final host is secure. Use an identity gateway with MFA for owner access, encrypt and restrict customer-data storage/backups, and verify the final HTTPS and proxy configuration.

- Use a Node 24-compatible host that can run the application server, terminate HTTPS, and accept Stripe webhooks. A static-files-only host cannot run the checkout API by itself.
- Build the frontend with the repository's build command and run the production server with the documented start command. Follow the root README for exact commands.
- Set `NODE_ENV=production`, `STORE_MODE`, `PUBLIC_BASE_URL`, and the payment/management secrets on the host. Point your domain's DNS records to that deployment and verify HTTPS.
- If the host places the server behind a reverse proxy, set `TRUST_PROXY_HOPS` only to the verified number of trusted proxy hops (supported values 1–3). The default does not trust forwarded IP headers. Do not guess this value; ask the host so request throttling identifies clients correctly.
- Provide a persistent volume for the database (`DATABASE_PATH`, default `.data/store.sqlite`) and private files (`DOWNLOAD_DIR`, default `private-downloads`). A temporary filesystem can lose orders, subscribers, and files when a deployment restarts. Keep protected backups and test restoration. Ensure the process working directory matches your configured relative paths, or use absolute production paths.
- Verify the public homepage, product detail, cart, newsletter consent, management access, checkout, signed webhook, and paid download on the deployed HTTPS domain. Test a phone-width viewport and keyboard navigation.
- Check that real secrets, the database, private downloads, logs, and `.env` cannot be fetched publicly. Ensure process logs exclude tokens and customer payment details.
- Add final business policies and contact details, then check every link and all product information.

## 5. Launch deliberately

Use [the social launch kit](SOCIAL-LAUNCH.md) to prepare assets and drafts. You must connect the relevant social accounts, review the final copy, and publish through your own account or an authorized integration. No posts or ads have been sent by this project. Paid campaigns need an approved budget and billing account.

Keep a simple launch record: date, channel, campaign link, spend, visits, checkout starts, completed payments, refunds, and customer questions. Use real payment records for revenue. Adjust the offer based on customer feedback; traffic and sales are not guaranteed.
