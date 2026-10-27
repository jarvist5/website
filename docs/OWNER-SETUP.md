# Private owner access

Owner management requires durable storage and a private activation link. The existing public preview is not an owner account, and publishing login screens alone does not make customer records persistent. Keep real payments disabled until the business launch checks are complete.

## Set up your account when activation is available

1. Open the private, expiring activation link delivered for this store. Keep it private; it is not the public website link.
2. Choose your owner username and a strong, unique password. Save the password in your password manager. The store stores a password hash, not the password itself.
3. Add the displayed account to an authenticator app using the locally generated QR code or setup secret. Verify the six-digit code to finish activation.
4. Save the one-time recovery codes somewhere secure and separate from your phone. Download them when the setup screen offers them; the store cannot display the originals later.
5. Sign in from the owner-login screen with your password and authenticator code. Sign out when finished, especially on a shared computer.

Do not put passwords, activation links, authenticator secrets or recovery codes into product descriptions, social posts, Git, or chat. An expired or already-used activation link cannot create another owner.

## Before adding real products or customers

- Confirm that the owner account and an innocuous test catalog change survive a real server restart/redeployment.
- Replace sample listings with products you own or are licensed to distribute. Attach real files only through the protected owner workflow, keeping paid files outside public assets.
- Complete your business identity, support contact, product licenses, privacy/retention policy and applicable refund/tax requirements.
- Use a provider that approves your Pakistan-based business, then verify payment and private-file delivery with that provider. The included Stripe adapter does not establish your eligibility.
- Keep the public site's practice checkout clearly labeled until the live-business requirements are complete. Account setup does not enable real card payments.

## Hosting and storage checklist for the deployment operator

The currently deployed service started on Render's free plan, whose local filesystem is temporary. Persistent owner records, catalog changes, orders and paid files need a durable storage arrangement. A paid upgrade must stay within the owner's explicitly approved budget; confirm the provider's current prices before activating paid resources. The often-cited Starter-plus-1-GB-disk figure is an estimate until the current provider price is verified.

For the existing SQLite application, the prepared API route is a paid compute service plus a persistent disk mounted outside the public web root:

- Keep the existing service identity and deployment branch; do not create an unrelated account or duplicate service.
- Configure `DATABASE_PATH=/var/data/store.sqlite` and `DOWNLOAD_DIR=/var/data/private-downloads` only after the disk exists and is mounted.
- Verify write access as the application's unprivileged runtime user. Restart/redeploy and prove that a test record remains before claiming durability.
- Enable `OWNER_MANAGEMENT_ENABLED=true` only with `OWNER_STORAGE_PERSISTENT=true` after durability checks. Keep `PUBLIC_PREVIEW=true` for customers while the owner prepares products; owner access is a separate authenticated feature.
- Keep `OWNER_AUTH_KEY` stable in the hosting provider's secure environment configuration. It protects authenticator secrets at rest; changing or losing it can prevent account recovery. Include this key in your protected disaster-recovery plan, outside Git and public files.
- Use an expiring `OWNER_SETUP_TOKEN` with `OWNER_SETUP_EXPIRES` (ISO 8601) for initial activation only. Use a separate stable `DOWNLOAD_SIGNING_KEY` for eventual paid downloads. Never expose a public, unclaimed registration endpoint or a shared default password.
- Configure HTTPS, trusted public origin, secure session cookies and CSRF checks. Keep deployment and authentication credentials out of logs.
- Back up the SQLite database consistently and protect the backups and private files. Test restoration separately. The provider exposes disk-snapshot APIs, but snapshot schedule and retention must be confirmed rather than assumed.

If permanent storage is not approved or cannot be provisioned, retain public-preview mode and report that limitation. Do not quietly enable customer collection on temporary storage.

## Verified Render API shapes

These shapes come from Render's official CLI-generated REST schema. They are documentation only; they do not authorize paid resource creation.

```text
PATCH /v1/services/{serviceId}
{"serviceDetails":{"plan":"starter"}}

POST /v1/disks
{"name":"leafivo-data","serviceId":"<existing service>","mountPath":"/var/data","sizeGB":1}

PUT /v1/services/{serviceId}/env-vars/{key}
{"value":"<secure or non-secret configured value>"}

POST /v1/services/{serviceId}/deploys
{"clearCache":"do_not_clear","commitId":"<verified full source SHA>"}
```

An individual environment-variable upsert preserves unrelated bindings. Adding a disk requires a service redeploy before attachment. Never delete or replace an existing disk to resolve an installation problem without establishing a recoverable backup and obtaining the appropriate authorization.

## Current readiness

The authentication and private-upload code is implemented. Local tests cover setup, authenticator codes, recovery, CSRF, cookie sessions, account changes, private file uploads, catalog editing, logout and database restart. No real owner account or shared owner password has been created. Public activation remains blocked on storage-budget approval, current provider pricing, and a verified persistent volume. This document does not imply a paid upgrade has happened.
