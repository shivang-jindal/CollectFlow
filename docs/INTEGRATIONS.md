# CollectFlow — Integrations

Two integration boundaries exist: **email**, which has real adapters, and
**online payments**, which has storage, encryption, status and a webhook route
but **no provider adapter**. Both report their real state; neither simulates a
connection.

The rule the whole product is built around: **never claim an external action
succeeded unless the external service confirmed it.**

---

# Part 1 — Email (SMTP)

## 1.1 What email is used for

| Use | Where |
| --- | --- |
| Send an invoice to a customer | `POST /:orgId/invoices/:id/send` |
| Send a scheduled payment reminder | `reminders.schedule` → `email.deliver` job |
| Invite a member | `POST /:orgId/members/invitations` (the accept link is always returned so it can be passed on manually) |
| Password reset | `POST /auth/password/forgot` |
| Operator test message | `POST /:orgId/integrations/email_smtp/test-message` |

With no provider configured, **everything else still works**: invoices can be
created, sent (which issues the public link) and downloaded as PDF, payments can
be recorded manually, reports and exports work. Email is additive, never
required.

## 1.2 The adapter contract

`server/src/integrations/email/types.ts` distinguishes three states that are easy
to conflate:

| Field | Meaning |
| --- | --- |
| `deliversMessages` | A real provider will actually attempt delivery. `true` for SMTP only. |
| `verifyConfiguration()` | `transporter.verify()` — did the provider accept a **connection**? |
| `send()` → `accepted` | Did the provider accept **this message**? |

| Adapter | `name` | `deliversMessages` | When selected |
| --- | --- | --- | --- |
| Nodemailer SMTP | `smtp` | `true` | `EMAIL_PROVIDER=smtp` |
| Development outbox | `log` | `false` | `EMAIL_PROVIDER=log` — **development only** |
| Disabled | `disabled` | `false` | `EMAIL_PROVIDER=disabled` (the default) |

## 1.3 Setup

### Step 1 — get SMTP credentials

Any provider with an SMTP interface works: a transactional-email provider
(Resend, Brevo, Mailgun, Postmark, Amazon SES) or your own mail server. The
provider you pick determines the host, port and whether TLS is implicit.

Record: host, port, security mode, username, password, and the sender address
your provider will let you send from. The sender address must be on a domain you
control and that your provider has verified.

### Step 2 — sandbox first

Use the provider's **sandbox or test credentials** before sending anything to a
real customer. Resend and Postmark accept any address while a domain is in test
mode; SES starts in the sandbox with a sending quota of one message per second;
Brevo and Mailgun have staging domains. Verify that real mail is actually
deliverable before going live — the sandbox only proves the credentials work.

### Step 3 — configure the environment

```bash
# macOS / Linux
export EMAIL_PROVIDER=smtp
export SMTP_HOST=smtp.example.com
export SMTP_PORT=587
export SMTP_SECURE=false
export SMTP_USER=apikey
export SMTP_PASSWORD=your-provider-api-key
export FROM_EMAIL=billing@yourdomain.example
export EMAIL_REPLY_TO=accounts@yourdomain.example     # optional
```

```powershell
# Windows PowerShell
$env:EMAIL_PROVIDER   = 'smtp'
$env:SMTP_HOST        = 'smtp.example.com'
$env:SMTP_PORT        = '587'
$env:SMTP_SECURE      = 'false'
$env:SMTP_USER        = 'apikey'
$env:SMTP_PASSWORD    = 'your-provider-api-key'
$env:FROM_EMAIL       = 'billing@yourdomain.example'
$env:EMAIL_REPLY_TO   = 'accounts@yourdomain.example'
```

Port guidance:

| Port | `SMTP_SECURE` | When |
| --- | --- | --- |
| `587` | `false` | STARTTLS — the normal choice |
| `465` | `true` | Implicit TLS |
| `25` | `false` | Plain relay; rarely appropriate |

`EMAIL_PROVIDER=smtp` without `SMTP_HOST` and `FROM_EMAIL` is a **startup
failure**, not a silent fallback:

> `EMAIL_PROVIDER=smtp requires SMTP_HOST and FROM_EMAIL. Set
> EMAIL_PROVIDER=disabled to run without email.`

If `SMTP_USER` and `SMTP_PASSWORD` are both empty the transporter connects
unauthenticated, which some relays allow.

Restart the API and the worker — the adapter is built from the environment at
startup.

### Step 4 — verify the connection

`POST /api/v1/:organizationId/integrations/email_smtp/test` performs a real
`transporter.verify()`:

```json
{ "ok": true, "detail": "SMTP smtp.example.com:587 accepted a connection.", "status": "configured" }
```

On failure it returns `ok: false`, `status: "error"` and a redacted reason. The
result is persisted as `lastCheckedAt` / `lastErrorCode` / `lastErrorMessage`
and audited as `integration.tested`. The Integrations screen shows the outcome
and the last check time.

### Step 5 — send a test message

`POST /api/v1/:organizationId/integrations/email_smtp/test-message` with
`{ "to": "you@example.com" }`. This is the only step that proves end-to-end
delivery to an inbox. The message body itself is explicit:

> This is a test message from CollectFlow. If you received it, the email
> provider accepted the message. CollectFlow cannot confirm delivery because
> plain SMTP does not report it.

### Step 6 — confirm in the product

Open **Reminders → Outbox**. Each row shows the status, the provider message id,
the failure code and a redacted failure message. With SMTP the statuses you will
see are `queued`, `sent` and `failed`.

## 1.4 What `sent` means — and what it does not

**`sent` means the SMTP server accepted the message for delivery. That is the
strongest claim plain SMTP supports.**

SMTP returns `250 OK` when it takes responsibility for the message. It does not
tell you whether the message reached a mailbox, whether it was filtered, or
whether it was opened. There is no delivery receipt, no bounce webhook and no
open tracking in this release.

| Term | Used by CollectFlow? | Meaning |
| --- | --- | --- |
| `queued` | yes | Persisted in `email_messages`, not yet handed to a provider |
| `sent` | yes | **The provider accepted the message.** Not delivered, not read |
| `delivered` | **never written** | Would require provider evidence CollectFlow does not have |
| `bounced` | never written | Would require a bounce callback that does not exist |

The vocabulary in `REMINDER_LOG_STATUSES` includes `delivered` and `bounced` for
a future provider callback, but the product never asserts either without
evidence.

Where this is stated in the product, not just in this file:

- `GET /:orgId/reminders/outbox` returns a `note` field saying exactly this.
- The test email tells the recipient this.
- The invoice email footer says CollectFlow is not a bank or payment processor
  and to contact the organization directly if the message was unexpected.
- The invoice PDF footer states CollectFlow is not a bank, payment processor or
  tax adviser, and that tax figures are recorded as entered by the issuer.
- **There is no "viewed" event in the invoice timeline.** Without open tracking
  there is no evidence, so the timeline never claims the customer read the
  invoice.

If you need delivery or bounce visibility, use a provider that exposes a
webhook API and build an adapter. That work is not done here.

## 1.5 Failure codes and what CollectFlow does with them

Classified in `SmtpEmailAdapter.classify`:

| `failureCode` | Trigger | Retryable | Recorded |
| --- | --- | --- | --- |
| `not_configured` | `EMAIL_PROVIDER=disabled` | **No** — permanent until an operator configures it | `email_messages.failureCode`, safe message |
| `auth_failed` | Nodemailer `EAUTH`, `EENVELOPE` | No | as above |
| `temporary` | `ECONNECTION`, `ETIMEDOUT`, `EDNS`, `ESOCKET` | **Yes** | as above |
| `permanent_recipient` | "invalid recipient" / "does not exist" in the provider message | No | as above |
| `provider_error` | anything else | **Yes** | as above |

Behaviour:

- A failure is stored on `email_messages.failure_code` and a redacted
  `safe_failure_message` (≤ 300 characters, secrets stripped), never a raw
  provider dump.
- For a `queued` `email.deliver` job, a **retryable** failure re-queues with
  bounded exponential backoff (5 s × 2^(attempts−1), capped at 15 min, plus up
  to 30 s of jitter; 5 attempts total). A **non-retryable** failure, or an
  exhausted budget, sets the job to `failed` and leaves it visible in
  `background_jobs` with its error code — a dead letter an operator can find,
  not an infinite retry.
- `email.deliver` treats a "not configured" result as permanent so the queue does
  not spin while the environment is broken.
- Every message is written to `email_messages` **before** an attempt, so what
  was queued, what the provider accepted and what failed is all visible
  afterwards.
- The invoice email uses a per-day idempotency key, so a failed send can be
  retried the next day without ever sending two copies on the same date.

## 1.6 Credential handling

Two mechanisms exist and they are separate on purpose.

| | SMTP (server-level) | Integration record (organization-level) |
| --- | --- | --- |
| Where the credential lives | Process environment | `integrations.encrypted_credentials_json` |
| Who supplies it | The operator, at deploy time | An owner/admin through `PUT /:orgId/integrations/email_smtp` |
| At rest | Host secret store | AES-256-GCM, keyed by `ENCRYPTION_KEY` |
| Readable again | Yes, by the process | Only decrypted inside the process; the API returns `********last4` at most |
| Used by the SMTP adapter | Yes — this is the configuration the adapter actually reads | No |

In practice: **sending email is configured with environment variables.**
`EMAIL_PROVIDER=smtp` and the `SMTP_*` variables are what
`SmtpEmailAdapter` uses. The `email_smtp` integration row is a per-organization
record of the connection and its verification state, surfaced on the
Integrations screen; it does not override the adapter's transport in this
release. That is stated plainly rather than implied.

`ENCRYPTION_KEY` is required before any credential can be stored. Without it,
`PUT /integrations/:provider` returns:

> `422 UNPROCESSABLE` — "ENCRYPTION_KEY is not configured on the server, so
> credentials cannot be stored safely. Set ENCRYPTION_KEY and restart the API, or
> use manual payment recording."

## 1.7 Rotating SMTP credentials

1. Create the new credential in the provider. Do **not** revoke the old one yet.
2. Set the new `SMTP_USER` / `SMTP_PASSWORD` in the deployment environment.
3. Restart the API **and** the worker — both hold a transporter.
4. `POST /integrations/email_smtp/test` → expect `ok: true`.
5. `POST /integrations/email_smtp/test-message` to an inbox you control.
6. Revoke the old credential in the provider.

Rotating `ENCRYPTION_KEY` is a different operation: stored credentials become
unreadable immediately (a wrong key fails the GCM authentication tag, and
`openCredentials` returns `{}` rather than garbage). To rotate it safely, re-save
each integration's credentials through the API after changing the key.

## 1.8 Disconnect and reconnect

**Disconnect** — `DELETE /api/v1/:orgId/integrations/email_smtp`:

- Clears the sealed credentials, sets `status='not_configured'`, `enabled=false`.
- Audits `integration.disconnected`.
- The Integrations card returns to **Not connected** with its setup guide.
- Nothing else in the product changes. Invoices, PDFs, payments, reports,
  reminders configuration and the public links all keep working. Reminder emails
  stop being delivered and their jobs fail with `not_configured`, visibly.

To stop sending entirely at the transport level, set
`EMAIL_PROVIDER=disabled` and restart — the adapter becomes
`DisabledEmailAdapter`, `verifyConfiguration` reports not ok, and the UI shows
"Not connected".

**Reconnect** — restore the environment variables and restart, then run
`POST /integrations/email_smtp/test` and the test message. There is no stored
state that has to be migrated: the adapter is built from the environment at
startup, and the integration row is simply overwritten by the next save or test.

---

# Part 2 — The payment provider boundary

## 2.1 The status, stated plainly

**No payment-provider adapter ships in this release. Online payment is not
available.**

Every surface that could imply otherwise says so explicitly:

| Surface | What it says |
| --- | --- |
| `GET /:orgId/integrations` → `payment_provider` | `status: "not_configured"`, `deliversMessages: false` |
| `POST /:orgId/integrations/payment_provider/test` | `ok: false` — "CollectFlow cannot verify a provider it has no credentials for." |
| `POST /api/v1/webhooks/payments/:provider` | `503 INTEGRATION_UNAVAILABLE` — "Nothing has been recorded as paid." |
| `GET /api/v1/public/invoices/:token` | `onlinePayment.available: false` with a reason |
| The web client's Integrations screen | Badge **Not connected**, plus the setup guide and the limitations list |
| The sidebar footer | "CollectFlow tracks invoices and payments. It is not a bank or payment processor." |
| The public invoice page | The reason string is rendered instead of a pay button |

The smoke test asserts this: with no provider, it requires
`payment_provider === "not_configured"`.

## 2.2 What exists already

| Piece | State |
| --- | --- |
| Storage | `integrations` row per `(organization_id, 'payment_provider')` |
| Encryption | AES-256-GCM at rest, `ENCRYPTION_KEY`, masked display, refuses to store without a key |
| Setup guide | Four steps shown in the UI (obtain a merchant account, store the key id and secret, register the webhook URL and signing secret, verify before enabling) |
| Verification action | Real: it probes what it can and honestly reports that it cannot verify a provider it has no credentials for |
| Status persistence | `lastCheckedAt`, `lastErrorCode`, `lastErrorMessage` |
| Audit | `integration.updated`, `integration.tested`, `integration.disconnected` |
| Webhook inbox | `webhook_events` table with a unique `(provider, provider_event_id)` index and a `payload_hash` — the event is recorded, the payload is not |
| Ledger support | `PaymentService.recordProviderPayment` with deduplication on `(organization_id, provider_name, provider_transaction_id)` and a partial unique index |
| Public page | `onlinePayment.available: false` with an explanation |

## 2.3 What is not implemented

- Any provider SDK, REST client or GraphQL client.
- **Webhook signature verification.** There is no `hmacSha256Hex` comparison
  against a request signature anywhere in the request path.
- Order or payment creation, hosted checkout pages, or return-URL handling.
- Any code path that marks an invoice `paid` from a provider event.
- Refund/chargeback API calls to a provider.
- A credentials form in the UI. `PUT /:orgId/integrations/payment_provider` is
  implemented and permission-checked, but no screen calls it, so credentials
  can only be stored through the API.
- Reconciliation against a provider dashboard.

## 2.4 Why no adapter ships

The product specification's MVP boundary is explicit: *"one real
payment-provider adapter only if account credentials are available."*

Merchant account approval is a per-provider, per-country process involving
identity checks, business documentation, bank settlement accounts and a signed
commercial agreement. **None of that can be obtained or exercised from a build
machine.** Shipping an adapter that has never exchanged a signature with a real
provider, or that has never seen a real settlement event, would mean shipping
code whose "success" path has never been verified — exactly the failure the
whole specification is written to prevent ("Never claim an external action
succeeded unless the external service confirms it").

So the boundary is built completely and labelled truthfully, and the adapter is
left for an operator who has a merchant account. That is the honest outcome, and
it is a smaller claim than "integrated".

## 2.5 What building an adapter would require

For whoever picks this up:

1. **Credentials.** A merchant account with a provider operating in the target
   country, its key id and secret, and its webhook signing secret.
2. **A driver behind the existing boundary.** Implement an adapter whose shape
   mirrors `EmailAdapter` (`name`, `deliversMessages`, `verifyConfiguration`,
   `send`/equivalent), selected in `createEmailAdapter`'s sibling
   `createPaymentAdapter`, and wired into `IntegrationService`.
3. **Signature verification.** Read the raw request body (the webhook route
   already installs a 1 MB JSON parser before the global one), compute the
   provider's HMAC with `hmacSha256Hex`, compare with `safeEqual` (constant
   time, already in `server/src/lib/crypto.ts`), reject on mismatch before any
   parsing, and enforce a timestamp tolerance to stop replays.
4. **Event deduplication.** Insert into `webhook_events` with
   `onConflictDoNothing` on `(provider, provider_event_id)`; only a fresh insert
   may proceed to reconciliation. `payment_allocations` and the
   `(organization_id, provider_name, provider_transaction_id)` unique index are
   already in place to make a second payment impossible.
5. **Organization resolution.** Map the provider's merchant account to an
   `organization_id` — `integrationOwner(db, organizationId)` already exists to
   attribute the creating actor.
6. **Reconciliation, never trust the browser.** Create the payment through
   `PaymentService.recordProviderPayment`, then allocate through
   `PaymentService.allocate` inside one transaction so the invoice status,
   reminder cancellation and the audit event are consistent. A provider success
   redirect is **not** proof of payment; only the verified server-side webhook
   or API confirmation is.
7. **Failure taxonomy.** Distinguish permanent failures (invalid signature, unknown
   merchant, closed event) from transient ones (timeout, provider 5xx), because
   the queue retries only the latter.
8. **Tests.** Signature-verification tests, replay tests, cross-tenant
   reconciliation tests — plus a mocked adapter in tests only. Production code
   must use the actual configured adapter, never a mock.
9. **Documentation.** Replace this section with real setup steps, scopes,
   webhook URLs, sandbox credentials and the provider's own limits.

## 2.6 Merchant approval and fees are outside CollectFlow

This sentence is shown in the product, not just here.

CollectFlow records and reports. It does not:

- approve, verify or onboard merchants,
- move, hold or reconcile funds,
- settle, refund or chargeback on a provider's behalf,
- charge a fee, or set one,
- provide any compliance or regulatory status.

Money movement always happens between the customer, the customer's bank and the
payment provider. CollectFlow's only claim is what its own ledger rows say:
*"this amount was recorded against this invoice"*. Manual recording is always
labelled **manually recorded** — never "provider-confirmed".

---

# Part 3 — The development `log` transport

## 3.1 What it does

`EMAIL_PROVIDER=log` selects `LogEmailAdapter`, which:

- writes each message to `server/.data/outbox/<id>.eml` as a plain-text file,
- returns `accepted: true` so the whole reminder pipeline can be exercised,
- sets `deliversMessages: false` so the UI says "Configured (development
  transport)" rather than "Connected",
- labels every file `CollectFlow development outbox (NOT DELIVERED)`,
- reports `providerMessageId` as `dev_<base36 timestamp>`,
- returns a `temporary` failure if the outbox cannot be written.

Messages still appear in `email_messages` with `status: 'sent'`, exactly as with
SMTP — which is precisely why it must never be used anywhere real.

## 3.2 Why it must never be used in production

**The API refuses to start with it.** `config.ts`:

> `EMAIL_PROVIDER=log is a development-only transport and cannot be used in
> production.`

That is a hard startup failure, not a warning, because the failure mode is
silent and severe:

| Risk | Consequence |
| --- | --- |
| No message ever leaves the machine | Invoices and reminders appear sent and reach nobody |
| `email_messages.status` becomes `sent` | The operator's outbox claims a provider accepted the message |
| `reminder_logs.status` becomes `sent` | The reminder log claims delivery |
| The Integrations card says "Configured (development transport)" | Easy to read as connected at a glance |
| `.eml` files accumulate in `server/.data/outbox` | Customer names, addresses and invoice data on disk, unencrypted, unbounded |

There is also a startup warning whenever it is used at all:

> `EMAIL_PROVIDER=log`: messages are written to the log and the outbox only.
> Nothing is delivered. No delivery is claimed.

## 3.3 Using it locally

```powershell
$env:EMAIL_PROVIDER = 'log'
npm.cmd run db:migrate
npm.cmd run db:seed
npm.cmd run dev
```

Then read `server/.data/outbox/*.eml`. Invitation, password-reset and invoice
links all appear there, which makes it the fastest way to test the reminder
pipeline and the email templates without a provider.

Remember that it is for development only, and that the files contain real
customer data if you seeded from real data.

---

## Reference — environment variables for integrations

| Variable | Purpose | Default |
| --- | --- | --- |
| `EMAIL_PROVIDER` | `disabled` \| `smtp` \| `log` | `disabled` |
| `SMTP_HOST` | Required for `smtp` | – |
| `SMTP_PORT` | SMTP port | `587` if unset |
| `SMTP_SECURE` | Implicit TLS (`true` for port 465) | `false` |
| `SMTP_USER` | Username; unauthenticated when both user and password are empty | – |
| `SMTP_PASSWORD` | Password | – |
| `FROM_EMAIL` | Required for `smtp`; sender of every message | falls back to `CollectFlow <no-reply@collectflow.local>` |
| `EMAIL_REPLY_TO` | Optional `Reply-To` | – |
| `ENCRYPTION_KEY` | 64 hex characters; AES-256-GCM for stored integration credentials | – |
| `WORKER_ENABLED` | Run the reminder/delivery loop | `true` |
| `WORKER_POLL_INTERVAL_MS` | Queue poll interval | `2000` |
| `WORKER_CONCURRENCY` | Claims per drain pass | `3` |

Generate a key:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```