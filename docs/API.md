# CollectFlow — API Reference

Base URL: `{API_URL}/api/v1`. Every request and response body is JSON, except
the two download endpoints (PDF and CSV). Timestamps are ISO 8601 in UTC;
calendar dates are `YYYY-MM-DD`.

Derived from the routers in `server/src/http/routes/`. There is **no generated
OpenAPI document** — this file is the reference and is maintained by hand.

---

## 1. Conventions

### 1.1 Authentication

Every tenant route requires the session cookie:

```
Cookie: collectflow_session=<opaque token>
```

`Authorization: Bearer <token>` is also accepted for server-to-server clients
and is the same opaque session token. There is no API key.

Public routes, which need no session:

| Route | Why |
| --- | --- |
| `GET /api/v1/health/*` | Orchestrator probes; excluded from rate limiting |
| `GET /api/v1/public/invoices/:token` | Customer-facing invoice link, token-scoped |
| `POST /api/v1/auth/google` | Google sign-in; the only sign-in method in the web app |
| `POST /api/v1/auth/register`, `/login`, `/password/*` | Development and tests only; return `404` in production |
| `POST /api/v1/webhooks/payments/:provider` | Provider callbacks |

### 1.2 Standard error envelope

Every non-2xx response uses one shape:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Readable explanation.",
    "fields": { "dueDate": ["Due date cannot be before the issue date"] },
    "issues": [{ "path": "dueDate", "message": "Due date cannot be before the issue date" }],
    "requestId": "req_lz3k9f2h1a0b7c"
  }
}
```

| Field | Always present | Notes |
| --- | --- | --- |
| `code` | yes | See the table below |
| `message` | yes | Safe to show a user. Never contains a stack trace |
| `fields` | on validation failures | Map of field path → messages |
| `issues` | on validation failures | Same information as a list |
| `requestId` | yes | Also returned in logs; quote it in a bug report |

`requestId` comes from the incoming `X-Request-Id` header (truncated to 80
characters) or is generated as `req_<base36>`. It is echoed back by the web
client and is the correlation id in every log line.

### 1.3 Error codes

| HTTP | `code` | Raised when |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | Zod body/query/param validation failed, or the body is not valid JSON |
| 401 | `UNAUTHENTICATED` | No session, expired session, disabled account, or bad credentials |
| 403 | `FORBIDDEN` | The role lacks the required permission; the message names it |
| 404 | `NOT_FOUND` | The record does not exist, is not visible to the caller, or belongs to another tenant. Also an unknown route, and an unknown or revoked public token |
| 405/other | — | Express default; the API is JSON-first, so an unmatched method falls through to the 404 envelope |
| 409 | `CONFLICT` | Duplicate email, duplicate customer email, already-used invitation, missing invoice sequence |
| 422 | `UNPROCESSABLE` | A domain rule was violated: wrong invoice state, over-allocation, currency mismatch, void with payments, future payment date, manual payments disabled, bad ownership-transfer confirmation, missing `ENCRYPTION_KEY` |
| 429 | `RATE_LIMITED` | Rate limit exceeded. `Retry-After` / `RateLimit-*` headers are sent (draft-7 standard headers) |
| 500 | `INTERNAL_ERROR` | Unexpected failure. Logged server-side with the stack; the client only gets the fixed message |
| 503 | `INTEGRATION_UNAVAILABLE` | A required integration is not configured — currently only the payment-provider webhook |

### 1.4 Pagination

Every list endpoint accepts:

| Parameter | Type | Default | Notes |
| --- | --- | --- | --- |
| `page` | integer ≥ 1 | `1` | |
| `pageSize` | integer 1–100 | `25` | Hard cap `MAX_PAGE_SIZE = 100`; a larger value is a `400` |
| `sort` | enum | per endpoint | See each endpoint |
| `order` | `asc` \| `desc` | per endpoint | |

and returns:

```json
{ "items": [ ... ], "page": 1, "pageSize": 25, "total": 137, "totalPages": 6 }
```

`totalPages` is at least 1 so the UI never renders "0 pages".

### 1.5 Idempotency

**There is no `Idempotency-Key` HTTP header in this release.** Repeating a
`POST` repeats the operation. Where duplication would be harmful, idempotency is
enforced internally by a stored key rather than by a client-supplied one:

| Operation | Key | Effect of a repeat |
| --- | --- | --- |
| Reminder scheduling | `(organizationId, invoiceId, ruleId, targetDate)` | Unique index on `reminder_logs.idempotency_key` + `ON CONFLICT DO NOTHING` → no second email |
| Reminder email outbox | `reminder:<org>:<invoice>:<rule>:<targetDate>` | Returns the existing message id |
| Email delivery job | `email-deliver:<messageId>` | One delivery per message |
| Invoice send email | `<org>:invoice_sent:<invoice>:<YYYY-MM-DD>` | One invoice email per invoice per calendar day |
| Recurring jobs | `maintenance.cleanup:<bucket>`, `reminders.schedule:<org>:<bucket>`, `invoices.reconcile:<org>:<bucket>` (15-minute buckets) | A restart does not duplicate |
| Provider payment | `(organizationId, providerName, providerTransactionId)` | Partial unique index → returns the existing payment |
| Public invoice token | — | Reused across resends; only rotated explicitly |
| Invoice creation | — | **Not** idempotent. Each call allocates a new number |
| Payment recording | — | **Not** idempotent. Each call creates a new ledger event |

### 1.6 Money on the wire

Authenticated endpoints use **integer minor units** with a `…Minor` suffix
(`totalMinor`, `amountMinor`, `balanceMinor`). The public invoice route is the
one exception: it returns decimal **strings** (`"1234.56"`) so a client can
never mis-parse them as a float. Currency exponents follow ISO 4217 (JPY 0,
KWD 3, default 2).

---

## 2. Health

No authentication. Excluded from the `/api/v1` rate limiter.

| Method | Path | Response |
| --- | --- | --- |
| `GET` | `/health/live` | `200 { status: "ok", service: "collectflow-api", version: "1.0.0" }` |
| `GET` | `/health/ready` | `200` or `503` — see below |
| `GET` | `/health/info` | `200` — see below |

`/health/ready`:

```json
{
  "status": "ready",
  "checks": [
    { "name": "database", "ok": true },
    { "name": "email", "ok": true, "detail": "disabled: No email provider is configured. Email sending is disabled." }
  ],
  "warnings": [ "DATABASE_URL is not set: using the embedded PGlite PostgreSQL instance. …" ],
  "environment": "development"
}
```

- `503` with `status: "not_ready"` when the `select 1` database probe fails. The
  failure message is included in `checks[].detail` but no connection string or
  secret is exposed.
- **Email never makes the service unready.** The email check is always
  `ok: true` with a `detail` string, because the product works with PDF download
  and manual payments when email is down. Email health is *reported*, not
  *gating*.
- `warnings` repeats the startup configuration warnings (`ENCRYPTION_KEY` not
  set, `DATABASE_URL` not set, `EMAIL_PROVIDER=log`, `COOKIE_SECURE` off in
  production).

`/health/info` returns the service name, environment, the worker configuration,
the email adapter name with `deliversMessages` and its `setupHint`, and the same
`warnings`.

---

## 3. Authentication — `/api/v1/auth`

| Method | Path | Auth | Permission |
| --- | --- | --- | --- |
| `POST` | `/auth/google` | – | – |
| `POST` | `/auth/register` | – | Development only |
| `POST` | `/auth/login` | – | Development only |
| `POST` | `/auth/logout` | – | – |
| `GET` | `/auth/session` | – | – |
| `GET` | `/auth/me` | session | any member |
| `PATCH` | `/auth/me` | session | any member |
| `POST` | `/auth/password/change` | session | Development only |
| `POST` | `/auth/password/forgot` | – | Development only |
| `POST` | `/auth/password/reset` | – | Development only |
| `GET` | `/auth/organizations` | session | any member |
| `POST` | `/auth/organizations` | session | any member |
| `POST` | `/auth/organizations/:organizationId/switch` | session | membership required |
| `POST` | `/auth/accept-invitation` | session | – |

### `POST /auth/google` → `200`

The only sign-in method in the web app. The browser completes the Google popup
with Firebase and sends the resulting ID token:

| Field | Type | Rules |
| --- | --- | --- |
| `idToken` | string | A Firebase ID token for the configured project |

The server verifies the RS256 signature against Google's published keys, the
issuer and audience, `firebase.sign_in_provider === "google.com"` and
`email_verified === true`. Accounts are matched by the verified email; a new
account is created with no password hash. Returns `AuthSessionResponse` and sets
the session cookie.

Errors: `401 UNAUTHENTICATED` (invalid token), `503 INTEGRATION_UNAVAILABLE`
(`FIREBASE_PROJECT_ID` not configured), `429 RATE_LIMITED`.

`/auth/register`, `/auth/login` and the `/auth/password/*` routes below are
development-only. They exist for the seed, the smoke script and the automated
tests, and return `404 NOT_FOUND` when `NODE_ENV=production`.

### `POST /auth/register` → `201` (development only)

Request

| Field | Type | Rules |
| --- | --- | --- |
| `email` | string | Valid email, lower-cased, unique |
| `password` | string | 10–200 characters |
| `displayName` | string | 1–120 characters, trimmed |

Sets the session cookie and returns `AuthSessionResponse`:

```json
{
  "user": { "id": "…", "email": "…", "displayName": "…", "createdAt": "2026-01-04T09:12:00.000Z" },
  "memberships": [],
  "activeOrganizationId": null
}
```

`memberships` is empty until an organization is created, so the client routes
the new user to `/welcome`.

Errors: `400 VALIDATION_ERROR`, `409 CONFLICT` (email taken).

### `POST /auth/login` → `200` (development only)

Request `{ "email": string, "password": string }`. Returns `AuthSessionResponse`
and sets the cookie. `401 UNAUTHENTICATED` with **the same message** whether the
account is missing or the password is wrong: "Email or password is incorrect."
A disabled account also returns `401`.

### `POST /auth/logout` → `204`

Revokes the session server-side and clears the cookie. Safe to call
anonymously.

### `GET /auth/session` → `200` / `401`

Returns `AuthSessionResponse`. `activeOrganizationId` is the session's stored
organization if the user is still a member, otherwise the first membership, or
`null`.

### `GET /auth/me` → `{ "user": SessionUser }`

### `PATCH /auth/me` → `{ "user": SessionUser }`

Request `{ "displayName"?: string }` (1–120 characters).

### `POST /auth/password/change` → `204` (development only)

Request `{ "currentPassword": string, "newPassword": string }`. On success **all**
sessions for the user are revoked and the cookie is cleared, so every device
must sign in again.

Errors: `400` (current password wrong), `422` (the new password equals the
current one).

### `POST /auth/password/forgot` → `200` (development only)

Request `{ "email": string, "organizationId"?: uuid }` (the second field is
accepted and unused).

```json
{
  "ok": true,
  "message": "If that account exists, a reset link has been sent. Without a working email provider the link is only reachable in development logs.",
  "resetEmailAvailable": true
}
```

The response is identical whether or not the account exists. The token is
256-bit, stored only as a SHA-256 hash, single-use, and expires after 60
minutes. `resetEmailAvailable` is `false` when no working provider is
configured — and then, with `EMAIL_PROVIDER=log`, the link is in
`server/.data/outbox/`.

### `POST /auth/password/reset` → `204` (development only)

Request `{ "token": string (20–400), "password": string }`. Consumes the token,
rehashes the password and revokes all sessions. `400` if the token is invalid,
used or expired.

### `GET /auth/organizations` → `200`

```json
{ "organizations": [ MembershipSummary, … ] }
```

`MembershipSummary` = `{ organizationId, organizationName, organizationSlug,
baseCurrency, timezone, role, permissions[] }`. Only `active` memberships of
non-deleted organizations are listed.

### `POST /auth/organizations` → `201`

Request:

| Field | Rules |
| --- | --- |
| `name` | 2–120 characters, trimmed |
| `countryCode` | 2 letters, upper-cased |
| `timezone` | Valid IANA zone; invalid → `400 { timezone: ["Unknown timezone"] }` |
| `baseCurrency` | 3 letters, must be in `SUPPORTED_CURRENCIES` |

Creates the organization, makes the caller its `owner`, and in the same
transaction creates the default `organization_settings` row, the
`invoice_sequences` row (`prefix 'INV-'`, `next_number 1`) and the
`organization.created` audit event. Email templates and the four default
reminder rules are then seeded (all **disabled**).

Response `{ "organization": OrganizationRecord }`.

### `POST /auth/organizations/:organizationId/switch` → `200`

Membership is re-checked **before** the session pointer moves. Returns
`AuthSessionResponse` with the new `activeOrganizationId`. `404` if the caller
is not a member.

### `POST /auth/accept-invitation` → `201`

Request `{ "token": string }`. Returns
`{ "organization": OrganizationRecord, "session": AuthSessionResponse }`. Also
seeds templates and default reminder rules. `400` for an invalid, used or
expired token; `409` if another request claimed it first.

---

## 4. Session context — `/api/v1/session`

| Method | Path | Auth |
| --- | --- | --- |
| `GET` | `/session/context` | session |

Returns `AuthSessionResponse` (same shape as `/auth/session`). `401` without a
session.

---

## 5. Organization — `/api/v1/:organizationId`

`OrganizationRecord` = `{ id, name, slug, countryCode, timezone, baseCurrency,
logoUrl, addressLine1, addressLine2, city, region, postalCode, taxIdentifier,
createdAt }`.

| Method | Path | Permission |
| --- | --- | --- |
| `GET` | `/:organizationId/` | any member |
| `PATCH` | `/:organizationId/` | `settings.manage` |
| `GET` | `/:organizationId/settings/invoices` | any member |
| `PATCH` | `/:organizationId/settings/invoices` | `settings.manage` |
| `GET` | `/:organizationId/members` | any member |
| `POST` | `/:organizationId/members/invitations` | `member.manage` |
| `GET` | `/:organizationId/members/invitations` | `member.manage` |
| `DELETE` | `/:organizationId/members/invitations/:invitationId` | `member.manage` |
| `PATCH` | `/:organizationId/members/:memberId` | `member.manage` |
| `DELETE` | `/:organizationId/members/:memberId` | `member.manage` |
| `POST` | `/:organizationId/transfer-ownership` | `ownership.transfer` |
| `GET` | `/:organizationId/audit` | `audit.view` |

### `GET /:organizationId/`

```json
{
  "organization": OrganizationRecord,
  "role": "owner",
  "permissions": ["invoice.create", "invoice.edit", …],
  "settings": OrganizationSettingsRow | null
}
```

`OrganizationSettingsRow` = `{ organizationId, invoicePrefix, nextNumber,
defaultTerms, defaultPaymentInstructions, defaultNotes, defaultDueDays,
taxLabel, taxRateBasisPoints, allowManualPayments, allowIssueDateAfterDueDate,
quietHoursStart, quietHoursEnd, remindersPaused, reminderOptOut, updatedAt }`.
Defaults: prefix `INV-`, `nextNumber 1`, `defaultDueDays 14`, tax label `Tax`,
tax rate `0`, `allowManualPayments true`, `allowIssueDateAfterDueDate false`,
**`remindersPaused true`**.

### `PATCH /:organizationId/`

Any subset of `{ name, countryCode, timezone, logoUrl, addressLine1,
addressLine2, city, region, postalCode, taxIdentifier }`. At least one field is
required. `logoUrl` must be a URL or `null`; `timezone` is validated. Writes an
`organization.updated` audit event listing the changed field names. `422` is
**not** used for a base-currency change because the base currency is not
editable here — it is set at organization creation.

### `GET|PATCH /:organizationId/settings/invoices`

`PATCH` accepts any subset of `updateInvoiceSettingsSchema`:

| Field | Type | Constraint |
| --- | --- | --- |
| `invoicePrefix` | string ≤ 12 | `[A-Za-z0-9-]*` |
| `nextNumber` | integer | 1 … 999 999 999 |
| `defaultTerms` / `defaultPaymentInstructions` / `defaultNotes` | string ≤ 2000 or `null` | |
| `defaultDueDays` | integer | 0 … 365 |
| `taxLabel` | string ≤ 32 | |
| `taxRateBasisPoints` | integer | 0 … 10 000 |
| `allowManualPayments` | boolean | |
| `allowIssueDateAfterDueDate` | boolean | |
| `quietHoursStart` / `quietHoursEnd` | `HH:MM` or `null` | |
| `remindersPaused` | boolean | |

The sequence is kept in step: when a prefix is supplied, `invoice_sequences` is
updated to `greatest(current next_number, requested)`, so the counter can only
move forward and an existing invoice number can never be reused. Audited as
`settings.invoices.updated`.

### Members

`MemberRecord` = `{ id (membership id), userId, email, displayName, role,
status, createdAt }`.

`POST /members/invitations` — request `{ email, role }` with `role` in
`admin | member | viewer` (`owner` is rejected: ownership is transferred, not
invited). Response `201`:

```json
{ "invitation": { "expiresAt": "…", "acceptUrl": "https://app…/accept-invitation?token=…",
                  "emailed": false, "emailConfigured": false } }
```

The accept URL is always returned so the operator can pass it on manually.
`emailed` reflects the provider result — it is `false` when no provider is
configured, and the response says so rather than pretending. Token: 256-bit,
stored as a SHA-256 hash, single-use, expires in 7 days. `409` if the person is
already a member.

`GET /members/invitations` lists non-accepted invitations with a derived
`state` of `pending`, `expired` or `revoked`.

`PATCH /members/:memberId` — `{ role }`. Cannot target the owner (`422`), cannot
set `owner` (`422`, "Use the audited ownership transfer workflow"), and requires
the actor to be owner or admin. Audited as `member.role_changed` with `from`/`to`.

`DELETE /members/:memberId` — `204`. Cannot remove the owner (`422`), and you
cannot remove yourself (`422`). Audited as `member.removed`.

### `POST /transfer-ownership`

Request `{ "membershipId": uuid, "confirmation": "TRANSFER OWNERSHIP" }`. The
phrase must match exactly, otherwise `422` with a `fields.confirmation` entry.
Only the current owner may call it. In one transaction the target becomes
`owner`, the previous owner becomes `admin`, and
`organization.ownership_transferred` is written. Returns `{ member }`.

### `GET /audit`

Query: `page`, `pageSize` (≤ 100, default 25), `entityType`, `entityId`,
`action`. Returns `Paginated<AuditEvent>`:
`{ id, organizationId, actorUserId, action, entityType, entityId, metadata,
requestId, ipAddress, createdAt }`, newest first. Metadata is redacted before
storage.

---

## 6. Customers — `/api/v1/:organizationId/customers`

| Method | Path | Permission |
| --- | --- | --- |
| `GET` | `/customers` | any member |
| `GET` | `/customers/options?q=` | any member |
| `POST` | `/customers` | `customer.manage` |
| `GET` | `/customers/:customerId` | any member |
| `PATCH` | `/customers/:customerId` | `customer.manage` |
| `POST` | `/customers/:customerId/reminder-opt-out` | `customer.manage` |
| `POST` | `/customers/:customerId/archive` | `customer.manage` |

> The archive endpoint is mounted on the organization router, so its path is
> `/api/v1/:organizationId/customers/:customerId/archive`.

### `GET /customers`

Query: `page`, `pageSize`, `q` (≤ 120, matches name/email/legalName,
case-insensitive, `%`/`_` escaped), `status` (`active` default | `archived` |
`all`), `currency`, `sort` (`name` default | `created_at` | `outstanding`),
`order` (`asc` default).

`CustomerListItem` = `{ id, name, legalName, email, phone, currency,
taxIdentifier, status, outstandingMinor, invoiceCount, createdAt }`.

`outstandingMinor` sums non-void invoices with a positive balance. **It is not
currency-safe on this endpoint**: it is one integer across every currency on the
customer. `outstandingByCurrency` on the detail endpoint is the authoritative,
per-currency figure. Do not treat the list column as a money total when a
customer has more than one currency.

### `GET /customers/options?q=`

For the invoice customer picker. `{ "options": [{ id, name, email, currency }] }`
— active customers only, up to 20 (50 with a query).

### `POST /customers` → `201`

| Field | Type | Rules |
| --- | --- | --- |
| `name` | string | 1–160, required |
| `legalName` | string ≤ 160 \| null | |
| `email` | email \| null | Unique **within the organization**; `409` otherwise |
| `phone` | string \| null | `^\+?[0-9 ()-]{4,32}$` — permissive, international |
| `billingAddress` | object \| null | Strict: `{ line1?, line2?, city?, region?, postalCode?, countryCode? }` |
| `taxIdentifier` | string ≤ 64 \| null | |
| `notes` | string ≤ 4000 \| null | |
| `currency` | ISO code \| null | Preferred currency |

Returns `{ customer }`.

### `GET /customers/:customerId`

```json
{
  "customer": Customer,
  "invoices": [ { id, invoiceNumber, status, issueDate, dueDate, currency,
                  totalMinor, sentAt, paidMinor, balanceMinor } ],
  "payments":  [ { id, amountMinor, currency, method, status, source, paidAt, reference } ],
  "outstandingByCurrency": [ { currency, amountMinor } ],
  "timeline": [ AuditEvent ]
}
```

Invoices (50) and payments (50) are newest first. **There is no delete
endpoint** — a customer with financial history is archived, never deleted.
Archiving sets `status='archived'` and `archived_at`; archived customers cannot
be invoiced (`422`).

### `POST /customers/:customerId/reminder-opt-out`

Request `{ "optedOut": boolean }`. Returns `{ "reminderOptOut": boolean }`.
While `true`, the reminder scheduler skips this customer and counts the skip.

---

## 7. Invoices — `/api/v1/:organizationId/invoices`

| Method | Path | Permission |
| --- | --- | --- |
| `GET` | `/invoices` | any member |
| `POST` | `/invoices` | `invoice.create` |
| `GET` | `/invoices/:invoiceId` | any member |
| `PATCH` | `/invoices/:invoiceId` | `invoice.edit` |
| `POST` | `/invoices/:invoiceId/send` | `invoice.send` |
| `POST` | `/invoices/:invoiceId/duplicate` | `invoice.create` |
| `POST` | `/invoices/:invoiceId/void` | `invoice.edit` |
| `POST` | `/invoices/:invoiceId/public-link/revoke` | `invoice.send` |
| `GET` | `/invoices/:invoiceId/pdf` | `invoice.create` |

### `GET /invoices`

| Query | Values | Notes |
| --- | --- | --- |
| `page`, `pageSize` | | Default 1 / 25, cap 100 |
| `q` | ≤ 120 | Matches invoice number, notes, customer name or customer email |
| `status` | `all` (default) \| `draft` \| `sent` \| `partially_paid` \| `paid` \| `overdue` \| `void` | `sent` excludes overdue invoices; `overdue` = `sent`/`partially_paid` with `due_date < today` (organization timezone) |
| `customerId` | uuid | |
| `issueFrom`, `issueTo`, `dueFrom`, `dueTo` | `YYYY-MM-DD` | Inclusive |
| `currency` | ISO code | |
| `sort` | `issue_date` (default) \| `invoice_number` \| `due_date` \| `total_minor` \| `balance_minor` \| `updated_at` | |
| `order` | `desc` (default) \| `asc` | |

`InvoiceListItem` = `{ id, invoiceNumber, customerId, customerName, status,
displayStatus, issueDate, dueDate, currency, subtotalMinor, discountMinor,
taxMinor, totalMinor, paidMinor, balanceMinor, sentAt, paidAt, voidedAt,
updatedAt }`.

`status` is the stored lifecycle value; `displayStatus` adds the derived
`overdue`. `balanceMinor` is `0` for a void invoice. `paidMinor` is derived from
the effective-allocation SQL, so a partial refund is already reflected.

### `POST /invoices` → `201`

Request (`createInvoiceSchema`):

| Field | Type | Rules |
| --- | --- | --- |
| `customerId` | uuid | Must be an **active** customer of this organization |
| `issueDate` | `YYYY-MM-DD` | |
| `dueDate` | `YYYY-MM-DD` \| null | Optional; must be ≥ `issueDate` |
| `currency` | ISO code | Must be in `SUPPORTED_CURRENCIES` |
| `items` | array, 1–100 | Strict object per line (below) |
| `discountMinor` | integer ≥ 0 | Invoice-level discount, default `0` |
| `notes`, `terms`, `paymentInstructions` | string ≤ 4000 \| null | |
| `saveAsDraft` | boolean | Default `true` |

Line item:

| Field | Type | Rules |
| --- | --- | --- |
| `description` | string 1–500 | |
| `quantity` | string | `^\d+(\.\d{1,4})?$` — 1–4 decimals, non-negative |
| `unitPriceMinor` | integer ≥ 0 | |
| `discountMinor` | integer ≥ 0 | Optional; clamped to the line value |
| `taxRateBasisPoints` | integer 0–10 000 | Optional; `1800` = 18% |
| `sortOrder` | integer 0–1000 | Optional |

**Totals are recalculated on the server.** There is no `totalMinor` field to
submit; `subtotalMinor`, `discountMinor`, `taxMinor` and `totalMinor` in the
response are computed by `calculateInvoiceTotals`, with the invoice-level
discount allocated proportionally by the largest-remainder method and tax
recomputed on the post-discount net base.

Extra rules:

- An invoice with `dueDate === issueDate` can be saved as a draft but not sent.
- A `422` is raised if the customer is archived ("This customer is archived.
  Restore the customer before invoicing them.").
- The invoice number is allocated inside the same transaction.
- A `invoice_revisions` snapshot (version 1) is written.

Response:

```json
{ "invoice": { …totals, status, invoiceNumber… },
  "email": { "status": "sent", "message": "…", "providerMessageId": "…" } }
```

`email` is `null` for a draft. When `saveAsDraft: false`, the invoice is created
as `sent` and the email is queued **and delivered inline within this request** —
see the note under `POST /:invoiceId/send`.

### `GET /invoices/:invoiceId`

```json
{
  "invoice": { …, publicLinkActive: true, displayStatus: "overdue", version: 2 },
  "customer": Customer | null,
  "items": [ InvoiceItem ],
  "allocations": [ { id, amountMinor, paymentId, createdAt, paymentMethod,
                     paymentSource, paymentStatus, paymentReference, paidAt } ],
  "adjustments": [ { id, paymentId, type, amountMinor, reason, createdAt } ],
  "paidMinor": 300000,
  "balanceMinor": 0,
  "timeline": [ AuditEvent ]
}
```

`adjustments` lists every adjustment in the organization (they are not filtered
by this invoice's payments) — a documented over-breadth, safe because the caller
is already scoped to the organization.

Note: `paidMinor`/`balanceMinor` on this endpoint sum the raw allocation rows
rather than applying the reversal fraction. See
[PRODUCT_SPEC.md §5.3](PRODUCT_SPEC.md).

### `PATCH /invoices/:invoiceId`

Request: any subset of `createInvoiceSchema` minus `saveAsDraft`, plus
`reason?: string (≤ 500)` recorded on the revision.

- `422` if the invoice is `void` or is not `draft`: *"A sent invoice cannot be
  edited because it may already have been paid. Void it and issue a corrected
  invoice; the original stays in the audit trail."*
- Omitted `items` are read back from the database and recalculated, so a
  metadata-only patch does not change the total.
- `version` is incremented and a new `invoice_revisions` snapshot is written in
  the same transaction.

### `POST /invoices/:invoiceId/send`

Request `{ "sendEmail": boolean = true, "recipientEmail"?: email }`.

Response:

```json
{
  "invoice": { "id": "…", "status": "sent", "sentAt": "2026-…", "publicUrl": "https://app/i/<token>" },
  "publicToken": "<returned once, never again>",
  "delivery": { "status": "sent", "message": "The email provider accepted the message for delivery.",
                "providerMessageId": "…" }
}
```

- `publicToken` is returned **only** on the first send. It is stored as a
  SHA-256 hash and can never be recovered; rotate or re-issue by sending again
  with link rotation.
- `delivery` is `null` when `sendEmail: false`.
- `delivery.status` is `"sent"` (provider **accepted**) or `"failed"`.
  **`sent` never means delivered.** SMTP has no delivery receipt.
- If there is no recipient address: `delivery.status = "failed"` with the
  message *"No customer email address is on file, so no email was queued.
  Download the PDF instead."* and `publicToken` is still issued.
- A resend on the same calendar day reuses the existing outbox row
  (`<org>:invoice_sent:<invoice>:<date>`), so it cannot spam the customer. The
  email idempotency key is **not** time-of-day granular.
- The invoice is marked sent and the token issued **before** the email attempt,
  so a provider failure leaves the invoice intact and retryable.
- Audit: `invoice.sent` or `invoice.resent`, then `invoice.email_attempted` with
  the status and recipient.

`422` if the invoice is `void`, already `paid`/`partially_paid`, or its due date
is before its issue date.

> **Honest note on the "do not hold the request open" rule.** The send endpoint
> queues the outbox row and then calls `EmailService.deliver` inline, so the
> request does wait for the SMTP round trip (the adapter caps it with a 10 s
> connection timeout, 10 s greeting timeout and 20 s socket timeout). The
> `email.deliver` background job exists and is what the reminder pipeline uses.
> Moving the invoice-send path fully onto the job queue is listed as remaining
> work.

### `POST /invoices/:invoiceId/duplicate` → `201`

Request `{ "issueDate"?: YYYY-MM-DD, "dueDate"?: YYYY-MM-DD }` (both optional).
Copies the customer, currency, lines, invoice-level discount, notes, terms and
payment instructions into a **new draft with a new invoice number**. The source
invoice is untouched. Returns `{ invoice }`.

### `POST /invoices/:invoiceId/void`

Request `{ "reason": string }` — required, 3–500 characters.

- `422` if already void.
- `422` if the invoice has any recorded allocation: *"This invoice has recorded
  payments. Reverse or refund the payment first; payment records are never
  erased."*
- On success: `status='void'`, `voided_at`, `void_reason`, **the public link is
  revoked**, queued reminders are marked skipped, and `invoice.voided` is
  audited.

### `POST /invoices/:invoiceId/public-link/revoke` → `204`

Request `{ "reason"?: string ≤ 300 }` (accepted and ignored by the service;
revocation is audited without it). Sets `public_token_revoked_at`; the link
immediately returns `404`. A new link is issued on the next send.

### `GET /invoices/:invoiceId/pdf`

`200 application/pdf`, served inline with
`Content-Disposition: inline; filename="<sanitised-number>.pdf"`. Rendered by
pdfkit from the persisted invoice, organization and customer rows. Requires
`invoice.create`. `404` for another tenant's invoice.

---

## 8. Payments — `/api/v1/:organizationId/payments`

| Method | Path | Permission |
| --- | --- | --- |
| `GET` | `/payments` | any member |
| `POST` | `/payments/manual` | `payment.record` |
| `POST` | `/payments/:paymentId/allocate` | `payment.record` |
| `POST` | `/payments/:paymentId/adjustments` | `payment.record` |

### `GET /payments`

Query: `page`, `pageSize`, `q` (matches reference or customer name), `customerId`,
`invoiceId` (existence check), `method` (one of `bank_transfer`, `cash`, `cheque`,
`card`, `provider`, `other`), `status` (`all` default | `recorded` | `reversed` |
`refunded` | `chargeback`), `from`, `to` (on `paid_at`), `sort` (`paid_at` default
| `amount_minor` | `created_at`), `order` (`desc` default).

Item = `{ id, customerId, customerName, amountMinor, currency, method, source,
providerName, providerTransactionId, reference, paidAt, status, createdAt,
allocatedMinor, unallocatedMinor, invoiceIds[] }`.

`allocatedMinor` sums raw allocation rows (not the reversal-adjusted figure);
`unallocatedMinor` is the remainder. The reversal-adjusted per-invoice figures
are on the invoice list and detail.

### `POST /payments/manual` → `201`

| Field | Type | Rules |
| --- | --- | --- |
| `customerId` | uuid | Must belong to the organization |
| `amountMinor` | integer > 0 | |
| `currency` | ISO code | Must match every allocated invoice |
| `method` | `bank_transfer` \| `cash` \| `cheque` \| `card` \| `provider` \| `other` | Recorded as **manually recorded** |
| `paidAt` | `YYYY-MM-DD` | Cannot be in the future (`422`) |
| `reference` | string ≤ 200 \| null | Optional |
| `fundsReceivedConfirmed` | `true` | **Literal.** Omitting or sending `false` is a `400` |
| `allocations` | array 1–100 \| omitted | `{ invoiceId, amountMinor }`, must sum exactly to `amountMinor` |

If `allocations` is omitted, the payment is allocated oldest-first across the
customer's `sent`/`partially_paid` invoices in the same currency. If the amount
exceeds what is open, the request is `422` and names the covered amount. **There
is no unapplied-credit bucket** — over-payment must be refused or corrected.

Response `201`:

```json
{ "payment": { "id": "…", "amountMinor": 300000, "paidAt": "2026-…", … },
  "updatedInvoices": [ { "id": "…", "status": "paid" } ] }
```

If `allowManualPayments` is `false` for the organization, this returns `422`
telling the user an owner or admin can enable it in Settings.

The payment row, its allocations, every affected invoice's recomputed status and
the `payment.recorded_manual` audit event are written in one transaction. Queued
reminders for every touched invoice are then cancelled ("Invoice was paid." or
"Payment recorded.").

Errors: `404` unknown customer/invoice; `409`/`422` for currency mismatch, a
void target invoice, allocation above the outstanding balance, allocations that
do not sum to the payment, and a future date.

### `POST /payments/:paymentId/allocate`

Request `{ "allocations": [{ invoiceId, amountMinor }] }` (1–100). The payment
must still be `status = 'recorded'` (`422` otherwise). The new allocations must
not exceed the unallocated remainder; each target invoice's *current* balance is
validated **excluding this payment's own allocations**, so re-allocating is
allowed. Response `{ "updatedInvoices": [...] }`.

### `POST /payments/:paymentId/adjustments`

| Field | Type | Rules |
| --- | --- | --- |
| `type` | `refund` \| `reversal` \| `chargeback` | |
| `amountMinor` | integer > 0 | Must not exceed the still-reversible amount (`422` naming it) |
| `reason` | string 3–500 | Required |
| `externalReference` | string ≤ 200 \| null | Optional |

Response `{ "adjustmentId", "paymentStatus", "updatedInvoices" }`.

- The original payment row is **never** edited or deleted. Its `status` becomes
  `refunded`/`chargeback`/`reversed` only when the total adjusted amount reaches
  the full payment amount.
- Every affected invoice is recomputed **through the effective-allocation SQL**,
  so a partial reversal reduces each invoice proportionally and an invoice can
  move back from `paid` to `partially_paid`.
- The adjustment, the payment status update, the invoice recomputation and the
  `payment.<type>_recorded` audit event are written in **one transaction**, all
  through the same `tx` handle.

---

## 9. Integrations — `/api/v1/:organizationId/integrations`

| Method | Path | Permission |
| --- | --- | --- |
| `GET` | `/integrations` | any member |
| `PUT` | `/integrations/:provider` | `integration.manage` |
| `POST` | `/integrations/:provider/test` | `integration.manage` |
| `POST` | `/integrations/email_smtp/test-message` | `integration.manage` |
| `DELETE` | `/integrations/:provider` | `integration.manage` |

`:provider` is `email_smtp` or `payment_provider`; anything else is a `400`.

### `GET /integrations`

Always returns exactly two entries, so the UI can never omit one:

```json
{ "integrations": [
  { "provider": "email_smtp", "label": "Email (SMTP)",
    "status": "not_configured", "deliversMessages": false,
    "lastCheckedAt": null, "lastErrorCode": null, "lastErrorMessage": null,
    "maskedKeys": [], "setupGuide": ["…"], "capabilities": ["…"], "limitations": ["…"] },
  { "provider": "payment_provider", "label": "Online payment provider",
    "status": "not_configured", "deliversMessages": false,
    "lastCheckedAt": null, "lastErrorCode": null, "lastErrorMessage": null,
    "maskedKeys": [], "setupGuide": ["…"], "capabilities": ["…"], "limitations": ["…"] }
]}
```

`status` ∈ `not_configured | configured | error | disabled`. `deliversMessages`
is `true` only for a provider that will really attempt delivery.
`maskedKeys` shows `********last4` at most. `limitations` for the payment
provider includes: *"CollectFlow records online payments only after a
signature-verified provider webhook or server-side API confirmation arrives. A
browser success redirect is never treated as proof of payment."* and *"Merchant
account approval, settlement and provider fees are outside CollectFlow."*

### `PUT /integrations/:provider`

Request `{ "credentials": { "<key>": "<value, ≤ 2000 chars>" }, "enabled": boolean = true }`.
Credentials are sealed with AES-256-GCM before storage and are **never returned**.
`422` with a message naming `ENCRYPTION_KEY` if the key is not configured on the
server. Saving an empty `credentials` object leaves any existing sealed value
untouched. Audited as `integration.updated` with the key **names** only.

> No screen in the web client calls this endpoint. Credentials can only be
> stored through the API.

### `POST /integrations/:provider/test` → `200` **always**

`{ "ok": boolean, "detail": string, "status": … }`. Always `200`; check `ok`.

- `email_smtp` — performs a **real** `transporter.verify()` against the
  configured host. `ok: true` ⇒ `status: configured`; `ok: false` ⇒
  `status: error` with a redacted reason. Records `lastCheckedAt` and
  `integration.tested`.
- `payment_provider` — **always** `ok: false`:
  *"No online payment provider is configured. CollectFlow cannot verify a
  provider it has no credentials for. Save provider credentials first, or
  continue with manual payment recording."* `status: not_configured`.

### `POST /integrations/email_smtp/test-message`

Request `{ "to": email }`. Sends a real test message and returns the adapter
result `{ accepted, status, providerMessageId?, message }`. Writes an
`email_messages` row (`templateType: 'test'`) and the
`integration.test_email_sent` audit event. `503 INTEGRATION_UNAVAILABLE` if a
delivering provider is configured but fails verification. The message body
itself tells the recipient that receipt proves acceptance, not delivery.

### `DELETE /integrations/:provider` → `204`

Clears the sealed credentials, sets `status='not_configured'`, `enabled=false`,
and audits `integration.disconnected`. `404` if no row exists. The rest of the
product keeps working.

---

## 10. Dashboard, reports and exports — `/api/v1/:organizationId`

| Method | Path | Permission |
| --- | --- | --- |
| `GET` | `/dashboard` | any member |
| `GET` | `/reports/receivables` | any member |
| `GET` | `/reports/collections` | any member |
| `POST` | `/exports` | `report.export` |

### `GET /dashboard`

Query: `from`, `to` (`YYYY-MM-DD`, optional; default is the current calendar
month in the organization timezone). `currency` is accepted by the schema but
currently ignored.

```json
{
  "range": { "from": "2026-03-01", "to": "2026-03-18" },
  "currencyGroups": [ { "currency": "USD", "amountMinor": 277500 } ],
  "outstanding": [ { "currency": "USD", "amountMinor": 277500 } ],
  "overdue": [ { "currency": "USD", "amountMinor": 150000 } ],
  "collectedThisMonth": [ { "currency": "USD", "amountMinor": 170000 } ],
  "awaitingPaymentCount": 2, "overdueCount": 1, "draftCount": 0, "customerCount": 2,
  "recentInvoices": [ { id, invoiceNumber, customerName, issueDate, dueDate,
                        currency, totalMinor, balanceMinor, status, displayStatus } ],
  "recentPayments": [ { id, customerName, amountMinor, currency, method, source, paidAt } ],
  "followUps": [ … ],
  "collectedByMonth": [ { "month": "2026-03", "currency": "USD", "amountMinor": 0 } ],
  "definitions": { "outstanding": "…", "overdue": "…", "collectedThisMonth": "…",
                   "awaitingPaymentCount": "…", "currencyGrouping": "…" }
}
```

- Every monetary field is an **array grouped by currency**. There is no
  cross-currency total and no exchange rate.
- `recentInvoices` / `recentPayments` are capped at 8 each; `followUps` at 8,
  ordered by days overdue descending.
- `definitions` is machine-readable text shipped with the numbers; the UI shows
  it so no metric is unexplained.
- With no data every array is empty and every count is `0`.

### `GET /reports/receivables`

Query: `asOf` (`YYYY-MM-DD`, default today UTC), `currency` (optional filter).

```json
{
  "asOf": "2026-03-18",
  "totalsByCurrency": [ { "currency": "USD", "amountMinor": 277500 } ],
  "buckets": [ { "bucket": "current", "label": "Not yet due", "amountMinor": 0,
                 "invoiceCount": 0, "byCurrency": [] } ],
  "byCustomer": [ { customerId, customerName, currency, amountMinor, oldestDueDate } ],
  "excluded": { "voidInvoices": 0 }
}
```

Buckets in order: `current` (not yet due or no due date), `1_30`, `31_60`,
`61_90`, `90_plus`. Each bucket returns `amountMinor`/`invoiceCount` **and** a
per-currency breakdown. Only `sent` and `partially_paid` invoices with a
positive balance are counted; void invoices are excluded and their count is
returned in `excluded.voidInvoices`. `byCustomer` is sorted by amount, capped at
50 rows.

> `buckets[].amountMinor` is the sum **across** currencies and is therefore only
> meaningful when a single `currency` filter is used. `buckets[].byCurrency` is
> always the safe figure.

### `GET /reports/collections`

Query: `from`, `to` (default: start of the current year to today, UTC).

```json
{
  "range": { "from": "2026-01-01", "to": "2026-03-18" },
  "byMonth": [ { month, currency, amountMinor, count } ],
  "byMethod": [ { method, currency, amountMinor, count } ],
  "invoiceStatusCounts": [ { status, count } ],
  "customerBalances": [ { customerId, customerName, currency, outstandingMinor } ],
  "notes": [ "Void invoices are excluded from every collected and outstanding figure.", … ]
}
```

Every financial row is grouped by currency. `notes` states the exclusions and is
displayed verbatim.

### `POST /exports`

Request `{ "dataset": "invoices" | "customers" | "payments" | "aging", "filters": { … } }`
— note `filters` is accepted but currently unused by the service; the export
always covers the whole organization.

`filters` are not applied, so the export is always the full tenant dataset. This
is documented rather than silently ignored.

Response `200 text/csv; charset=utf-8` with
`Content-Disposition: attachment; filename="collectflow-<dataset>-<YYYY-MM-DD>.csv"`
and `X-Row-Count`. Every cell is formula-escaped; a UTF-8 BOM is prepended.

| Dataset | Columns |
| --- | --- |
| `invoices` | `invoice_number, customer, status, issue_date, due_date, currency, subtotal, discount, tax, total, paid, balance` |
| `customers` | `name, legal_name, email, phone, tax_identifier, preferred_currency, status` |
| `payments` | `payment_id, customer, amount, currency, method, source, status, reference, paid_at` |
| `aging` | `invoice_number, customer, currency, due_date, ageing, balance` |

The export service also implements a `reminders` dataset, but it is **not in the
Zod enum**, so requesting it returns `400 VALIDATION_ERROR`. Known gap.

Each export writes an `export.generated` audit event with the dataset and row
count, and is rate-limited by the global `/api/v1` limiter.

---

## 11. Reminders — `/api/v1/:organizationId`

| Method | Path | Permission |
| --- | --- | --- |
| `GET` | `/reminders/rules` | any member |
| `PATCH` | `/reminders/rules` | `settings.manage` |
| `GET` | `/reminders/logs` | any member |
| `GET` | `/reminders/outbox` | any member |
| `POST` | `/reminders/preview/:invoiceId` | any member |

### `GET /reminders/rules`

```json
{
  "rules": [ { id, organizationId, name, offsetDays, direction, enabled, templateId } ],
  "settings": { "remindersPaused": true, "quietHoursStart": null,
                "quietHoursEnd": null, "timezone": "America/New_York" },
  "email": { "provider": "disabled", "deliversMessages": false,
             "detail": "No email provider is configured. Email sending is disabled." }
}
```

`direction` ∈ `before | on | after`. `offsetDays` may be negative.

### `PATCH /reminders/rules`

Request `{ "rules": [ { id, name, offsetDays, direction, enabled, templateId } ] }`
(up to 50). `direction` and `templateId` are validated but only `enabled`,
`offsetDays` and `name` are persisted. Returns `{ rules }` (the full list) and
audits `settings.reminders.updated`.

### `GET /reminders/logs`

Query: `page`, `pageSize` (≤ 100, default 25), `invoiceId`, `status`, `from`,
`to` (on `created_at`). Returns `Paginated<ReminderLogRow>` = `{ id,
organizationId, invoiceId, customerId, ruleId, scheduledFor, sentAt,
providerMessageId, status, failureCode, safeFailureMessage, attemptCount,
idempotencyKey, subject, createdAt }`. `status` ∈ `queued | sent | delivered |
bounced | failed | skipped`; CollectFlow only ever writes `queued`, `sent` and
`skipped`.

### `GET /reminders/outbox`

```json
{ "messages": [ { id, templateType, toAddress, subject, status,
                  providerMessageId, failureCode, safeFailureMessage,
                  sentAt, createdAt } ],
  "counts": { "queued": 0, "sent": 3 },
  "note": "A message marked \"sent\" means the email provider accepted it for delivery. SMTP does not report delivery, so CollectFlow never claims an email was delivered." }
```

The 50 most recent messages for the organization.

### `POST /reminders/preview/:invoiceId`

No body. Returns `{ preview: { invoiceNumber, customerName, customerEmail,
dueDate, balanceMinor, balanceFormatted, reminderOptOut, rules: [ { id, name,
enabled, offsetDays, direction, targetDate } ] } }`, or `404` for another
tenant's invoice. Lets an operator see exactly what would be sent before
enabling a rule.

---

## 12. Public — `/api/v1/public`

### `GET /public/invoices/:token`

No authentication. **Rate limited to 30 requests per minute per IP**, answered
with the standard `RATE_LIMITED` envelope.

`:token` must match `^[A-Za-z0-9_-]{32,64}$`; anything else is a `404` without a
database query. The token is hashed with SHA-256 and matched against
`invoices.public_token_hash` with `public_token_revoked_at IS NULL`.

```json
{
  "organization": { "name": "Demo Studio", "address": ["22 Mission Street", "San Francisco", "US"] },
  "customer": { "name": "Acme Robotics" },
  "invoice": {
    "number": "INV-0001", "issueDate": "2026-03-01", "dueDate": "2026-03-22",
    "currency": "USD", "status": "partially_paid",
    "subtotal": "2400.00", "discount": "0.00", "tax": "0.00",
    "total": "2400.00", "paid": "1700.00", "balance": "700.00",
    "notes": null, "terms": null, "paymentInstructions": "Demo Studio Bank …"
  },
  "items": [ { "description": "Discovery workshop (2 days)", "quantity": "2",
               "unitPrice": "1200.00", "amount": "2400.00" } ],
  "onlinePayment": { "available": false, "reason": "No online payment provider is configured for this organization. Please use the payment instructions on the invoice." }
}
```

Explicitly **not** included: invoice id, organization id, customer id, the
customer's email, phone, notes, tax identifier or billing address, allocations,
payments, audit events, and the token hash. `balance` is derived from the same
effective-allocation SQL as every other surface. `404` for an unknown or revoked
token, with the same message in both cases.

---

## 13. Webhooks — `/api/v1/webhooks`

### `POST /webhooks/payments/:provider`

No authentication (the provider cannot hold a session). **Rate limited to
`AUTH_RATE_LIMIT_MAX` (default 20) per minute per IP.** The body limit is 1 MB.

**This route always fails.** It records the event for forensics — `provider`,
`providerEventId` (`body.event.id`, else `body.id`, else a SHA-256-derived
`unverified-…` id), `payload_hash` = SHA-256 of the body, `status: 'rejected'`,
`errorCode: 'provider_not_configured'`, unique on `(provider, providerEventId)`
— and then answers:

```
503 INTEGRATION_UNAVAILABLE
"No payment provider adapter is configured, so this webhook cannot be verified
or processed. Nothing has been recorded as paid."
```

No signature verification code exists in this release, and no payment is ever
created from this route. A browser success redirect is never treated as proof of
payment.

---

## 14. Not implemented

Endpoints named in the product specification that this release does **not**
expose. Listed so no one hunts for them:

| Endpoint | Status |
| --- | --- |
| `DELETE /api/v1/customers/:id` | Deliberately absent — customers are archived, never deleted |
| `DELETE /api/v1/invoices/:id` | Deliberately absent — invoices are voided, never deleted |
| `DELETE /api/v1/payments/:id` | Deliberately absent — the ledger is append-only; corrections are adjustments |
| `DELETE /api/v1/:organizationId` (organization deletion) | Not implemented; `organizations.deleted_at` exists and is honoured on read |
| `POST /api/v1/:organizationId/exports/:id/download` | Not implemented; exports are generated synchronously and streamed |
| `GET /api/v1/:organizationId/jobs` (job admin UI) | `JobQueue.listFailed`/`stats`/`retry` exist in the service; no route exposes them |
| Email template editing | Templates are seeded per organization; there is no CRUD route or UI |
| `GET /api/v1/openapi.json` | Not generated; this document is the reference |