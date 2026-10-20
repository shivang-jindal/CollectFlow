# Security

This document states the security assumptions CollectFlow makes, what it does
and does not protect against, and how to report a vulnerability safely.

**We do not make legal compliance claims.** CollectFlow does not claim or imply
conformity with GDPR, HIPAA, PCI DSS, SOC 2, ISO 27001, or any other legal or
certification regime. Compliance is the operator's responsibility and depends on
how the product is deployed and used. Nothing here is legal advice. A privacy
notice and terms of service are the operator's to write and have reviewed.

---

## 1. Reporting a vulnerability

**Do not open a public issue, pull request or discussion for a security
problem.**

Report privately to the repository owner through the private security advisory
function of the hosting platform (GitHub: *Security → Report a vulnerability* on
the repository), or by direct private message to the maintainer.

Please include:

- What the issue is and which component is affected (API, worker, web client).
- Steps to reproduce, ideally as a request pair or a short script.
- The impact you believe it has, and which tenant boundary it crosses.
- Whether any real customer data is involved.

What to expect:

| | |
| --- | --- |
| Acknowledgement | Within 3 working days |
| First assessment | Within 10 working days |
| Fix or mitigation plan | Published to the reporter before disclosure |
| Credit | Offered unless the reporter asks otherwise |

Please do not access data belonging to other tenants, do not run automated
scans against third-party systems, and do not exfiltrate, modify or delete
customer data. Give the maintainer a reasonable window to ship a fix before
disclosure. Good-faith research, with no data access and no degradation of
service, is not treated as abuse.

Out of scope: findings that require an operator to deliberately misconfigure the
product (for example setting `COOKIE_SECURE=false` in production, or shipping a
shared `ENCRYPTION_KEY` across tenants), and the limitations listed in §9.

---

## 2. Authentication model

| Concern | Implementation |
| --- | --- |
| Password hashing | Argon2id via `@node-rs/argon2` — `memoryCost 19456 KiB`, `timeCost 2`, `parallelism 1`, 32-byte output (`server/src/lib/crypto.ts`). No hand-rolled KDF. |
| Session token | 32 bytes (256 bits) from `node:crypto` `randomBytes`, base64url-encoded |
| Session storage | Only `SHA-256(token)` is stored in `sessions.token_hash` (unique index). The token itself is never persisted. |
| Transport of the session | HTTP-only cookie `collectflow_session` (configurable via `SESSION_COOKIE_NAME`), `SameSite=Lax`, `Path=/`, `Expires` set from `SESSION_TTL_HOURS`, `Secure` when `COOKIE_SECURE` is on — which defaults to on in production |
| Server-side revocation | `sessions.revoked_at`; `POST /api/v1/auth/logout` revokes, password change and password reset revoke **all** sessions for the user |
| Expiry | Enforced on every request in `AuthService.authenticate`; the `maintenance.cleanup` job deletes sessions past `expires_at` and revoked sessions older than 30 days |
| Browser storage | No token in `localStorage` or `sessionStorage`. `client/src/lib/api.ts` uses `credentials: 'include'` on every call. |
| Alternative credential | `Authorization: Bearer <token>` is accepted by `sessionTokenOf` for API clients and tests; the token is the same opaque session token and is never logged (see §7) |

Other authentication behaviours:

- Login failures return the identical message and status whether the account
  does not exist or the password is wrong, and always run an Argon2 verification
  against a dummy hash, so the two cases take a comparable amount of time
  (`server/src/services/auth.service.ts`).
- Passwords must be at least 10 characters (`shared/src/schemas.ts`).
- Password reset tokens and invitation tokens are 256-bit random, stored only as
  SHA-256 hashes, expire (60 minutes / 7 days) and are single-use. Invitation
  acceptance claims the row with a conditional `UPDATE ... WHERE accepted_at IS
  NULL`, so two concurrent accepts cannot both succeed.

**Not implemented:** email verification, multi-factor authentication, breached
password checks, login throttling (see §9), session management UI, and
per-user SSO.

---

## 3. Tenancy model

`organizations` is the tenant boundary. Every tenant-owned table carries a
non-null `organization_id` foreign key.

| Layer | Mechanism |
| --- | --- |
| Identity | `memberships` joins a `user` to an `organization` with a `role` and `status`; unique on `(organization_id, user_id)` |
| Request context | `requireOrganization` (`server/src/http/middleware.ts`) resolves `:organizationId`, calls `OrganizationService.requireMembership`, and sets `req.organization`, `req.organizationRole`, `req.permissions` |
| Trust model | An `organizationId` from the browser is **never** trusted on its own; membership is re-checked on every tenant request |
| Query scoping | Every service method takes `organizationId` as its first argument and adds `eq(table.organizationId, organizationId)` |
| Non-membership response | `requireMembership` throws the same `404` as a non-existent organization, so the API cannot be used to probe for foreign identifiers |
| Foreign records | Every read is `WHERE id = ? AND organization_id = ?`. A record owned by another tenant returns `404`, never `403` |
| Tests | `server/tests/domain.test.ts` and `server/tests/api.test.ts` assert cross-tenant `404`s, blocked cross-tenant allocation and separated lists |

Roles and permissions (`shared/src/constants.ts`):

| Permission | owner | admin | member | viewer |
| --- | :---: | :---: | :---: | :---: |
| `invoice.create` | yes | yes | yes | – |
| `invoice.edit` | yes | yes | yes | – |
| `invoice.send` | yes | yes | – | – |
| `payment.record` | yes | yes | – | – |
| `report.export` | yes | yes | yes | – |
| `customer.manage` | yes | yes | yes | – |
| `settings.manage` | yes | yes | – | – |
| `integration.manage` | yes | yes | – | – |
| `member.manage` | yes | yes | – | – |
| `audit.view` | yes | yes | – | – |
| `ownership.transfer` | yes | – | – | – |
| `organization.delete` | yes | – | – | – |

Guardrails on membership:

- The owner's role cannot be changed or the owner removed through the ordinary
  role-change path; an organization cannot be left without an owner.
- Ownership transfer requires the literal phrase `TRANSFER OWNERSHIP`, is
  restricted to the current owner, demotes the previous owner to `admin`, and
  writes an audit event.
- `viewer` holds no permissions at all and every write route requires an
  explicit permission.

**Not implemented:** organization deletion (the `organization.delete` permission
exists but no route consumes it — see §9), and account data export.

---

## 4. Input validation and injection defences

- Every route body, query string and path parameter is validated by a Zod schema
  from `shared/src/schemas.ts` through `server/src/http/validate.ts`. The same
  schemas run in the browser for inline feedback, but the server value is the
  only one that counts.
- `express.json` limits bodies to 2 MB (1 MB under `/api/v1/webhooks`); urlencoded
  to 256 KB.
- All database access goes through Drizzle's query builder with bound
  parameters. The two places that need SQL fragments use tagged templates
  (`sql\`\``) which also bind parameters. No string concatenation of user input
  into SQL.
- `LIKE` searches escape `%` and `_` in user input before the pattern is built.
- Email templates interpolate only an allow-list of placeholders
  (`server/src/integrations/email/templates.ts`); values are HTML-escaped for
  the HTML body and stripped of newlines for the plain-text body. Unknown
  `{{placeholders}}` are removed, not executed.
- PDF filenames are sanitised to `[A-Za-z0-9._-]` before being placed in the
  `Content-Disposition` header.
- CSV exports escape every cell; a leading `=`, `+`, `-`, `@`, tab or CR is
  prefixed with `'` to neutralise spreadsheet formula injection
  (`shared/src/csv.ts`).
- Security headers come from Helmet with a `default-src 'none'` CSP,
  `frame-ancestors 'none'`, `Referrer-Policy: no-referrer` and
  `Cross-Origin-Resource-Policy: same-site` (`server/src/app.ts`).
  `x-powered-by` is disabled.
- CORS is an explicit allow-list of `APP_URL` plus `APP_URLS`. A request with no
  `Origin` header (server-to-server) is allowed; a request with an unknown
  origin is refused. `credentials: true`, exposed headers limited to
  `Content-Disposition` and `X-Request-Id`.
- Error responses never include a stack trace. Unhandled errors are logged
  server-side and answered with a fixed message.

**CSRF.** Sessions are cookie-based, so CSRF matters. The cookie is
`SameSite=Lax`, which blocks cross-site POSTs from browsers; JSON requests also
require a `content-type` that a plain HTML form cannot send; and CORS is an
allow-list with credentials enabled. There is no separate synchroniser-token or
Origin-header check. See §9.

---

## 5. SSRF exposure

**CollectFlow never fetches a user-supplied URL.**

There is no "check this URL", "import from URL", webhook-test, avatar-upload or
link-preview feature. No HTTP client library (`fetch`, `axios`, `got`) is
called with a user-controlled URL anywhere in `server/`. The only outbound
network connections the server makes are:

| Destination | URL source | Validation |
| --- | --- | --- |
| Database | `DATABASE_URL` | Operator-controlled environment variable |
| SMTP relay | `SMTP_HOST` / `SMTP_PORT` | Operator-controlled environment variable |

The invoice PDF is generated in-process by `pdfkit`
(`server/src/pdf/invoice-pdf.ts`) from rows already in the database. It loads no
external resource, embeds no remote font or image, and executes no JavaScript
from any target.

This is stated precisely because CollectFlow has no URL-fetching feature at all,
so the usual SSRF mitigations (blocking localhost, private and link-local
ranges, cloud metadata addresses, validating DNS and every redirect) are
unnecessary rather than implemented. If a URL-fetching feature is ever added,
that analysis must be redone first.

---

## 6. Rate limiting

Three limiters are configured, all in-memory per process via
`express-rate-limit` with `standardHeaders: 'draft-7'`.

| Scope | Window | Limit | Source |
| --- | --- | --- | --- |
| All `/api/v1/*` except health | `RATE_LIMIT_WINDOW_MS` (60 s) | `RATE_LIMIT_MAX` (300) | `server/src/app.ts` |
| `POST /api/v1/webhooks/payments/:provider` | 60 s | `AUTH_RATE_LIMIT_MAX` (20) | `server/src/http/routes/webhooks.ts` |
| `GET /api/v1/public/invoices/:token` | 60 s | 30 | `server/src/http/routes/public.ts` |

Health endpoints are skipped so an orchestrator's probes do not consume the
budget.

**Limitation:** login, registration, password reset, invitation and
`PUT /api/v1/integrations/:provider` are **not** limited more tightly than the
global 300-per-minute budget. The configuration field `AUTH_RATE_LIMIT_MAX`
exists and is wired to the webhook route only. See §9. Behind multiple API
instances the limits are per instance, because the store is in memory.

---

## 7. Log redaction

`server/src/logger.ts` configures Pino with these redaction paths:
`req.headers.authorization`, `req.headers.cookie`, `headers.authorization`,
`headers.cookie`, `*.password`, `*.passwordHash`, `*.token`, `*.apiKey`,
`*.secret`, `credentials.*` — replaced with `[redacted]`.

Audit-event metadata is passed through `redactObject` before being written to
`audit_events.metadata_json`, which redacts the keys `password`, `passwordhash`,
`token`, `tokenhash`, `secret`, `apikey`, `api_key`, `authorization`, `cookie`,
`credentials`, `encryptedcredentials` and `smtp_password` at any nesting depth
up to 4.

Other redaction paths:

- `createDatabase` logs a redacted connection string (protocol, host, port,
  database name only).
- `SmtpEmailAdapter.safeMessage` strips `password|pass|secret|token|api_key`
  assignments from provider errors and truncates to 200 characters.
- Integration credentials are never returned to the browser; the API returns
  masked values only (`maskSecret` keeps at most the last four characters).
- Webhook payloads are stored as a SHA-256 hash (`webhook_events.payload_hash`),
  never as raw JSON.

**Not logged:** password hashes, plaintext passwords, session tokens, raw
`Authorization` headers, cookies, SMTP passwords, integration secrets. **Not
minimised further:** customer email addresses appear in email-template context
that is stored in `email_messages.to_address` and `body_text` — that is a
functional record, not a log.

---

## 8. Credential encryption at rest

Integration credentials are the only secrets stored in the database.

| Property | Value |
| --- | --- |
| Algorithm | AES-256-GCM, 12-byte random IV per seal (`server/src/lib/crypto.ts`) |
| Key | `ENCRYPTION_KEY`, 32 bytes as 64 hex characters; validated at startup |
| Format | base64 of a JSON envelope `{ v: 1, iv, tag, data }`, stored in `integrations.encrypted_credentials_json` |
| Versioning | `v` is checked on open; an unknown version is an error rather than a silent read |
| Key rotation | Not automated. Re-save the credentials after changing the key. **Rotating `ENCRYPTION_KEY` without re-saving makes stored credentials unreadable.** |
| Storage in transit | The key lives only in the server's environment / secret store |
| Without a key | `IntegrationService.save` refuses with `422` and a message naming `ENCRYPTION_KEY`; the API still starts and the Integrations screen says credentials cannot be stored |
| Display | `maskSecret` — `********last4` at most; the plaintext is never rendered again |

`ENCRYPTION_KEY` is a single server-wide key, not per tenant. Anyone who can
read the environment can decrypt every organization's stored credentials.

---

## 9. What CollectFlow does not store, and known limitations

### Never stored

| Data | Why |
| --- | --- |
| Card numbers, CVV, or any card track data | CollectFlow is not a payment processor and has no field for it. Online payments, when a provider is connected, happen on the provider's hosted page. |
| Plaintext passwords | Only an Argon2id hash is written to `users.password_hash` |
| Session tokens | Only `SHA-256(token)` in `sessions.token_hash` |
| Raw `Authorization` headers | Pino redaction plus the fact that no code path logs them |
| SMTP passwords | Environment variables only; never echoed to a response or a log |
| Plaintext integration secrets | AES-256-GCM envelope in `integrations.encrypted_credentials_json` |
| Raw payment webhook payloads | Only `SHA-256` of the body in `webhook_events.payload_hash` |

### Known limitations

1. **No payment-provider adapter ships.** `POST /api/v1/webhooks/payments/:provider`
   records the event as `rejected` with `provider_not_configured` and answers
   `503 INTEGRATION_UNAVAILABLE`. It cannot be used to mark anything paid. There
   is no signature verification code path in this release.
2. **No SMTP delivery receipt.** `sent` means the provider accepted the message.
   Bounces, opens and delivery are unknown and CollectFlow says so.
3. **Embedded PGlite is single-writer.** Two processes (API and worker) opening
   the same PGlite directory is unsupported. Production requires `DATABASE_URL`.
4. **Login is not separately rate-limited.** See §6.
5. **No CSRF synchroniser token.** See §4; protection relies on `SameSite=Lax`,
   JSON content types and the CORS allow-list.
6. **Rate-limit counters are in memory.** They reset on restart and are per
   instance.
7. **Password reset depends on a working email provider.** Without one, the
   endpoint returns `resetEmailAvailable: false` and the token is reachable only
   in development logs (`EMAIL_PROVIDER=log`).
8. **No email address verification** on registration, and **no account
   self-service deletion or data export**.
9. **`organization.delete` permission is declared but no route consumes it.**
   There is no organization-deletion endpoint, and therefore no deletion
   workflow, confirmation dialogue or retention policy. `organizations.deleted_at`
   exists and is honoured on read.
10. **Session cookies are `SameSite=Lax`, not `Strict`.** A same-site
    cross-origin navigation carries the cookie. This is deliberate: strict
    cookies break common "email link back to the app" flows.
11. **PDF rendering trusts stored text.** Values are drawn with pdfkit's
    standard fonts, so no font-parsing or script-execution surface is reached.
12. **Data retention.** `maintenance.cleanup` deletes expired/revoked sessions
    and expired password-reset tokens older than 30 days. Invoices, payments,
    audit events, reminder logs and email messages are retained indefinitely;
    no retention policy or purge job is implemented.
13. **Backups are the operator's responsibility.** No retention schedule or
    erasure-from-backups guarantee can be offered for third-party backup copies
    outside the application's control.
14. **OpenAPI is not generated.** `docs/API.md` is maintained by hand.

---

## 10. Deployment assumptions

These are assumptions, not guarantees. Violating them invalidates several
controls above.

| Assumption | Consequence if false |
| --- | --- |
| TLS terminates in front of the API and the client | Session cookies travel in clear text |
| `COOKIE_SECURE=true` in production (the default) | Cookies are sent over HTTP |
| `TRUST_PROXY=true` when behind a proxy | Rate limiting and client-IP logging use the wrong address |
| `ENCRYPTION_KEY` is high-entropy, unique and secret | Stored credentials are recoverable by anyone with the key |
| `DATABASE_URL` points at a database only the application can reach | Tenant isolation is not a substitute for network isolation |
| Backups exist and a restore has been tested | Data loss on failure |
| The seeded demo account is removed before public use | Anyone who reads the README can sign in |

---

## 11. Supported versions

| Version | Supported |
| --- | --- |
| 1.0.0 | Yes |

Security fixes are applied to the current minor version only.

---

## 12. Security-relevant dependencies

| Package | Used for |
| --- | --- |
| `@node-rs/argon2` | Argon2id password hashing (Rust implementation with prebuilt binaries) |
| `node:crypto` | `randomBytes`, `createHash`, `createHmac`, `createCipheriv`, `timingSafeEqual` |
| `helmet` | Security headers |
| `express-rate-limit` | Request throttling |
| `cookie-parser`, `cors` | Session cookie and origin handling |
| `nodemailer` | SMTP delivery |
| `pg`, `drizzle-orm` | Parameterised database access |
| `pdfkit` | Server-side PDF generation |

Keep them updated; `npm audit` runs against the lockfile in CI.