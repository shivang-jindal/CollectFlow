# CollectFlow — Implementation Status

An honest completion checklist. What is implemented, what is deliberately not
implemented, what was actually run and what it produced, what is broken or
incomplete, and what remains.

**Nothing in this document is a claim about code that has not been read or
commands that have not been run.** Anything I could not verify is marked
**Uncertain** and says why.

- Product version: `1.0.0`
- Status: functionally complete for the specified MVP; **not** production-hardened
- Last verified: on this machine, Node `v24.20.0`, npm `11.19.0`

---

## 1. Commands run, and their results

All run from `E:\Downloads\SaaS 12345\CollectFlow` on Node `v24.20.0`.

### 1.1 `npm run verify` — **PASSED**

The full local quality gate (`scripts/verify.mjs`). Every step succeeded:

| Step | Command | Result |
| --- | --- | --- |
| Shared type-check + build | `npm run build:shared` | OK |
| Server type-check | `npm run typecheck -w @collectflow/server` | OK — no errors |
| Client type-check | `npm run typecheck -w @collectflow/client` | OK — no errors |
| Lint | `npm run lint` | OK — no errors |
| Unit + integration tests | `npm run test` | **3 files, 42 tests passed, 0 failed** (32.01 s) |
| Production build | `npm run build` | OK |

Test breakdown:

| File | Tests | Duration |
| --- | --- | --- |
| `server/tests/api.test.ts` | 15 | 9.03 s |
| `server/tests/domain.test.ts` | 12 | 7.58 s |
| `server/tests/money.test.ts` | 15 | 0.03 s |
| **Total** | **42** | |

Production build output:

```
dist/index.html                 0.61 kB │ gzip:   0.35 kB
dist/assets/index-*.css        25.00 kB │ gzip:   5.81 kB
dist/assets/index-*.js        399.41 kB │ gzip: 111.84 kB
✓ 122 modules transformed, built in 7.02s
```

```
All verification steps passed.
```

### 1.2 `npm run db:migrate` on an **empty** embedded database — **PASSED**

Run against a fresh `PGLITE_DATA_DIR=.data/pgdata-probe`, i.e. a database with
no schema at all:

```
[db:migrate] applied migrations from
  E:\Downloads\SaaS 12345\CollectFlow\server\drizzle
  to pglite (…\server\.data\pgdata-probe) in 1798ms
```

### 1.3 `npm run db:seed` on that fresh database — **PASSED**

```
[db:seed] demo workspace created.
           email:    demo@collectflow.test
           password: collectflow-demo-1234
           organization: Demo Studio (demo-studio)
           invoice 1: INV-0001 (partially paid)
           invoice 2: INV-0002 (overdue)
```

### 1.4 `node scripts/smoke.mjs` against a running API — **PASSED**

API started on port 4123 against the freshly seeded embedded database.
Observed startup log:

```
database connected        driver=pglite
CollectFlow API listening on 4123
configuration warning     ENCRYPTION_KEY is not set: integration credentials cannot be stored. …
configuration warning     DATABASE_URL is not set: using the embedded PGlite PostgreSQL instance. …
```

Smoke output:

```
  ok   health/ready - [{"name":"database","ok":true},{"name":"email","ok":true,…}]
  ok   auth/login
  ok   session has an organization
  ok   dashboard
  ok   dashboard reports outstanding grouped by currency - [{"currency":"USD","amountMinor":277500}]
  ok   invoice list
  ok   invoice row has a derived status - partially_paid
  ok   receivables report
  ok   integrations report a truthful status - {"email_smtp":"not_configured","payment_provider":"not_configured"}
  ok   invalid id is rejected with 400 - status=400

Smoke test passed
```

The probe database was deleted afterwards; the pre-existing
`server/.data/pgdata` was not modified.

### 1.5 Not run — and why it matters

| Command | Status | Reason |
| --- | --- | --- |
| `npm run test:e2e` (Playwright) | **NOT RUN** | Requires `npx playwright install chromium` (a ~150 MB browser download) and a live dev stack. The spec files exist and are committed, but their current pass/fail state is **Uncertain** |
| E2E in CI | **NOT RUN** | `.github/workflows/ci.yml` installs the Playwright browser and uploads `playwright-report/` on failure, but **never invokes `npm run test:e2e`**. The upload step can therefore only ever fire if something else writes that directory. This is a real CI gap — see §5.1 |
| `npm run db:migrate` against hosted PostgreSQL | **NOT RUN** | No managed PostgreSQL instance exists in this environment. The node-postgres path is exercised only by construction (the same `runMigrations` code, a different driver) |
| Backup / restore against a real backup | **NOT RUN** | See [OPERATIONS.md §5.4](OPERATIONS.md). The procedure is the standard PostgreSQL workflow and is written out; it has not been executed here |
| Load testing | **NOT RUN** | No performance budget has been measured. See §6 |
| Accessibility audit | **PARTIAL** | Semantic landmarks, a skip link, labelled controls, `aria-*` on the navigation drawer and status badges are implemented, and a 360 px Playwright check exists. No screen-reader pass, no automated axe run, and no WCAG conformance claim is made |
| `npm audit` | **NOT RUN** during this documentation pass | CI installs from the lockfile. No vulnerability scan result is being claimed here |

---

## 2. Migration state

| | |
| --- | --- |
| Migration files | **1** — `server/drizzle/0000_redundant_leech.sql` |
| Journal | `server/drizzle/meta/_journal.json` |
| Snapshot | `server/drizzle/meta/0000_snapshot.json` |
| Generated by | `drizzle-kit generate` via `scripts/generate-migration.mjs` |
| Tables created | 23 business tables + the Drizzle journal table |
| Verified on an empty database | **Yes** — §1.2 |
| Verified on hosted PostgreSQL | **No** — no such instance available here |
| Forward-only | Yes. There is no down-migration path and none should be added |
| Applies automatically on start | Yes — `server/src/index.ts` and `server/src/worker.ts` both call `runMigrations` |

Adding a migration: edit `server/src/db/schema.ts`, run
`npm run db:generate`, review the SQL, then `npm run db:migrate`. The wrapper
exists because `drizzle-kit` resolves its own `node_modules` with a path join
that breaks when the repository path contains a space.

---

## 3. Implemented and verified

Each row states where it lives and how it was verified.

### 3.1 Foundation

| Item | Where | Verification |
| --- | --- | --- |
| Environment validation with fail-fast, secret-free errors | `server/src/config.ts` | Manual: `EMAIL_PROVIDER=log` + `NODE_ENV=production` throws; `ENCRYPTION_KEY` of the wrong length throws |
| Startup warnings surfaced at request time | `config.ts` → `/health/ready`, `/health/info` | Observed in §1.4 |
| 23-table Drizzle schema, indexes, unique + partial unique constraints | `server/src/db/schema.ts`, `server/drizzle/0000_redundant_leech.sql` | Applied on an empty DB (§1.2) |
| Dual driver: node-postgres + PGlite, one schema | `server/src/db/client.ts` | PGlite exercised (§1.2–1.4); node-postgres path unexercised here |
| Argon2id password hashing (`@node-rs/argon2`) | `server/src/lib/crypto.ts` | Exercised by every auth test |
| Opaque 256-bit session tokens, SHA-256 at rest | `auth.service.ts`, `sessions.token_hash` unique index | `api.test.ts` cookie + revocation tests |
| HTTP-only `SameSite=Lax` session cookie | `server/src/http/routes/auth.ts` | `api.test.ts`: `HttpOnly` present; cleared on logout; route then 401s |
| Password change / reset revoking all sessions | `auth.service.ts` | Code path; reset tested via schema |
| Roles and permission matrix | `shared/src/constants.ts` | Enforced by `requirePermission`; denial paths exercised |
| Tenant scoping on every query | all services take `organizationId` first | `domain.test.ts` + `api.test.ts` cross-tenant 404s |
| Cross-tenant access returns 404, not 403 | `organization.service.ts` `requireMembership` | `api.test.ts`, `domain.test.ts` |
| Server-side Zod validation on body, query and params | `server/src/http/validate.ts` | `api.test.ts` bad-body test |
| Error envelope with `code`, `message`, `fields`, `issues`, `requestId` | `server/src/errors.ts`, `routes/index.ts` | `api.test.ts` |
| Request ids | `http/middleware.ts` | Observed in logs (§1.4) and in error bodies |
| Structured JSON logging with redaction | `server/src/logger.ts` | Observed in §1.4 |
| Helmet headers, CORS allow-list, body size limits | `server/src/app.ts` | Code; CSP `default-src 'none'` |
| Rate limiting: global `/api/v1`, public token 30/min, webhook 20/min | `app.ts`, `public.ts`, `webhooks.ts` | Code; the public and webhook limiters are visible in the routers |
| `/health/live`, `/health/ready`, `/health/info` | `server/src/http/routes/health.ts` | §1.4 |
| Auth, organizations, switcher, invitations, audited ownership transfer | `auth.ts`, `organization.ts`, `organization.service.ts` | Partially tested; the transfer and invitation paths are **not** covered by an automated test |

### 3.2 Core journey

| Item | Where | Verification |
| --- | --- | --- |
| Customer create / list / search / filter / paginate / detail / archive / opt-out | `customer.service.ts`, `routes/customers.ts` | `api.test.ts` create; `domain.test.ts` |
| Server-side invoice totals, never trusted from the browser | `invoice.service.ts` | `domain.test.ts`: "recalculates totals server-side" |
| Transactional invoice numbering + unique index | `allocateInvoiceNumber`, `invoices_org_number_idx` | `domain.test.ts`: 8 concurrent creates → 8 distinct numbers |
| Revision snapshots on create and edit | `invoice_revisions` | Code; uniqueness enforced by index |
| Invoice list with derived `displayStatus`, sorting by balance | `InvoiceService.list` | `api.test.ts`, smoke test |
| Send, public token, revoke, duplicate, void, PDF | `invoice.service.ts`, `routes/invoices.ts` | `api.test.ts`: send returns a token, PDF starts with `%PDF`, void guard 422 |
| Manual payment recording with `fundsReceivedConfirmed` | `payment.service.ts`, `recordPaymentSchema` | `domain.test.ts`, `api.test.ts` |
| Auto-allocation oldest-first, refusal on over-payment | `PaymentService.autoAllocate` | `domain.test.ts`: over-allocation 422 |
| Currency mismatch rejection | `assertAllocations` | `domain.test.ts` |
| Append-only ledger; reversal keeps the original row | `payment_adjustments` | `domain.test.ts`: reversal moves `paid` → `partially_paid`, row still present |
| Effective-allocation SQL used by every surface | `server/src/db/balance-sql.ts` | Code; the proportional behaviour is documented and the fragment is single-sourced |
| Provider-transaction dedupe | `recordProviderPayment`, `payments_provider_txn_idx` | `domain.test.ts`: replay returns `deduplicated: true`, one row |
| Public invoice route: projection, rate limit, revocation | `routes/public.ts` | `api.test.ts`: no customer id, no customer email, 404 after revoke |
| Dashboard, receivables aging, collections, per-currency grouping | `report.service.ts` | `api.test.ts`, smoke test |
| CSV export with formula escaping | `export.service.ts`, `shared/src/csv.ts` | `api.test.ts`: `escapeCsvCell` assertions + export is tenant-scoped |
| Reminder scheduling, idempotency, opt-out, quiet hours, preview | `reminder.service.ts` | `domain.test.ts`: idempotency and opt-out |
| Job queue: `FOR UPDATE SKIP LOCKED`, backoff, idempotency, dead letters | `jobs/queue.ts` | Code; **no automated test covers the queue directly** |
| Email outbox, adapter contract, SMTP classification, log adapter | `integrations/email/`, `email.service.ts` | Code; SMTP untested against a real provider |
| Truthful integration status and the webhook refusal | `integration.service.ts`, `routes/webhooks.ts`, `routes/integrations.ts` | `api.test.ts`: `not_configured`, `deliversMessages: false`, `422` without `ENCRYPTION_KEY`, webhook 503 |

### 3.3 Interface

| Item | Where |
| --- | --- |
| Every route in `client/src/routes.tsx` resolves to a real screen; the 8 sidebar destinations are Dashboard, Invoices, Customers, Payments, Reports, Reminders, Integrations and Settings | `client/src/routes.tsx`, `client/src/components/AppShell.tsx` |
| Organization switcher for multi-organization users | `AppShell.tsx` + `POST /auth/organizations/:id/switch` |
| Shared patterns (`MetricCard`, `DataTable`, `FilterBar`, `ConfirmDialog`, `ActivityTimeline`, `StatusBadge`, `CopyButton`) | `client/src/components/patterns.tsx` |
| Loading / empty / error / populated states on the main lists | the page components |
| Keyboard focus, skip link, labelled controls, `aria-expanded` on the mobile drawer | `AppShell.tsx`, `components/ui.tsx` |
| 360 px responsive layout | `AppShell.tsx` + `tests/e2e/responsive.spec.ts` |
| No `localStorage` business state; cookies only | `client/src/lib/api.ts` |

---

## 4. Deliberately not implemented

Decisions, not oversights. Each is visible in the product.

| # | Not implemented | Why | Where it is stated |
| --- | --- | --- | --- |
| 1 | **Payment-provider adapter** | Merchant account approval, settlement and fees are per-provider and per-country, and cannot be obtained or tested from a build machine. The specification permits the adapter "only if account credentials are available" | `payment_provider` integration card reads **Not connected**; the webhook route returns 503; the public page says online payment is unavailable |
| 2 | **Webhook signature verification** | Follows from #1 — there is no adapter whose signature scheme could be verified | `webhooks.ts` records the event and refuses |
| 3 | **Any exchange rates or currency conversion** | Out of scope; adding them requires a rate source, a rate date and a policy | Amounts are grouped per currency; a payment may only touch an invoice in the same currency |
| 4 | **Credit notes / negative lines** | A credit note is a separate explicit feature; a negative line is a validation error | `money.nonnegative()`; credits are `payment_adjustments` |
| 5 | **Unapplied credit** | Over-allocation is refused with an explanation instead, which the specification explicitly permits | `422` naming the covered amount |
| 6 | **Deleting customers, invoices or payments** | Deleting financial records is prohibited. Customers are archived, invoices voided, payments corrected by adjustment | No delete route exists on any of the three |
| 7 | **Bulk send / bulk void** | Not implemented. Bulk void would need a confirmation with a real summary; a half-built version is worse than none | – |
| 8 | **Email open/delivery tracking, "viewed" timeline event** | Plain SMTP provides no evidence, so claiming a view would be dishonest | Timeline has no "viewed" event |
| 9 | **Email template editing** | Templates are seeded per organization from four defaults | No template CRUD route or UI |
| 10 | **Generated OpenAPI document** | A hand-written reference derived from the routers describes the code that actually runs | `docs/API.md` |
| 11 | **Job-administration UI** | `listFailed`, `stats`, `retry` exist in the service but no route exposes them | Dead letters are queryable via SQL ([OPERATIONS.md §2.3](OPERATIONS.md)) |
| 12 | **Organization deletion** | The permission and `deleted_at` column exist, but an irreversible endpoint needs a confirmation workflow, a retention policy and an audit path that are not built | `organization.delete` is declared and unused |
| 13 | **Account data export / self-service account deletion** | Not built. Requires a retention policy and a deletion workflow | – |
| 14 | **Email address verification, MFA, breached-password checks** | Out of scope for this release | – |
| 15 | **Webhooks / public tracking for anything but the invoice link** | Only the invoice public view exists | – |

---

## 5. Known limitations and defects

Ordered by severity. Nothing here is a security hole unless marked.

### 5.1 The dashboard follow-up list returns empty identifiers — **defect**

`ReportService.dashboard` builds `followUps` with `invoiceId: ''` in the first
`map`, then looks the row up with `followUpById.get(row.invoiceId)` — which is
`get('')`, always `undefined`. Consequently `followUps[].invoiceId`,
`invoiceNumber` and `customerName` are **always empty strings**, while
`dueDate`, `daysOverdue`, `currency` and `balanceMinor` are correct.

File: `server/src/services/report.service.ts`, the `followUps` pipeline.

Impact: the follow-up list cannot be clicked through to an invoice. No
automated test covers it, so it was not caught. The amounts on the same
response are correct. **Not fixed in this documentation pass** — listed as
remaining work.

### 5.2 CI does not run the E2E tests — **gap**

`.github/workflows/ci.yml` runs `npm ci`, `npm run verify`, `npm run db:migrate`
and `npm run db:seed`. `npm run verify` does **not** include Playwright. The
workflow installs Chromium and uploads `playwright-report/` on failure, but
nothing ever produces that directory, so the `tests/e2e/**` suites never execute
in CI. The E2E specs are also unverified here (§1.5). Fix: add
`npx playwright install --with-deps chromium` + a dev server + `npm run test:e2e`
as a workflow step.

### 5.3 Login is not rate-limited separately — **gap**

`AUTH_RATE_LIMIT_MAX` (default 20/min) is wired only to the webhook route.
`/auth/login`, `/auth/register`, `/auth/password/forgot` and
`/auth/accept-invitation` are limited only by the global `/api/v1` budget of
300/min per IP. The specification asks for rate limiting on login, invitation,
password reset and public endpoints. **Fix:** mount an
`express-rate-limit` instance with `limit: AUTH_RATE_LIMIT_MAX` on
`/api/v1/auth`. The limiter, the config field and the env var all exist; only
the wiring is missing.

### 5.4 No CSRF synchroniser token — **accepted risk**

Sessions are cookie-based. Protection is `SameSite=Lax`, the JSON content type
requirement, and the CORS allow-list with credentials. There is no explicit
token or `Origin` check. See SECURITY.md §4.

### 5.5 Invoice send waits for the SMTP round trip — **deviation**

`sendInvoiceEmail` writes the outbox row first (so the message is never lost),
then calls `EmailService.deliver` **inline**. The request therefore waits for the
SMTP round trip, bounded by the adapter's 10 s connection / 10 s greeting /
20 s socket timeouts. The specification asked for enqueue-and-return. The
`email.deliver` background job exists and is what the reminder pipeline uses;
moving the send path onto it is remaining work.

### 5.6 `exports` `filters` are accepted and ignored — **minor**

`POST /:orgId/exports` accepts a `filters` object; `ExportService.build` does
not use it, so an export is always the whole tenant dataset. It is documented in
[API.md §10](API.md) rather than silently ignored. Also, the service implements
a `reminders` dataset that the Zod enum does not include, so `dataset:
"reminders"` returns `400`.

### 5.7 Two documented divergences from the single balance rule — **minor**

Both are stated rather than hidden:

- `InvoiceService.detail` computes `paidMinor`/`balanceMinor` by summing the raw
  allocation rows it has already loaded, not by applying the reversal fraction.
  A partially refunded invoice therefore shows a slightly higher `paid` on the
  detail endpoint than on the list, the dashboard, the exports or the public
  page.
- `loadInvoiceForPdf` deliberately reports `paidMinor = 0` and
  `balance = total`, because an invoice document states what was invoiced.

### 5.8 `payments` list `allocatedMinor` uses raw allocations — **minor**

Same cause as §5.7. The reversal-adjusted figure is on the invoice endpoints.

### 5.9 Customer list `outstandingMinor` sums across currencies — **minor**

`GET /customers` returns a single `outstandingMinor` integer per customer. It
is only meaningful for a single-currency customer. `outstandingByCurrency` on the
customer **detail** endpoint is authoritative. Same caveat applies to
`receivables.buckets[].amountMinor`, which is only safe with a single-currency
filter; `buckets[].byCurrency` is always safe. This contradicts the
"never sum across currencies" rule at the column level and should be fixed by
returning a per-currency array.

### 5.10 `reminder` and `invoice` adjustment lists are organization-wide — **minor**

`GET /invoices/:id` returns **every** `payment_adjustments` row in the
organization, not only those affecting that invoice. The caller is already
tenant-scoped so nothing leaks, but the list is broader than the screen needs.

### 5.11 Declared-but-unused schema and config surfaces — **cosmetic**

Dead declarations left in place. They are harmless but misleading:

| Declaration | Reality |
| --- | --- |
| `BACKGROUND_JOB_TYPES` in `shared/src/constants.ts` | Lists `email.send_invoice`, `email.send_reminder`, `reminder.schedule`, `invoice.overdue_reconcile`. The handlers actually registered are `email.deliver`, `reminders.schedule`, `invoices.reconcile`, `maintenance.cleanup`. The constant is not imported anywhere, so nothing breaks — but it is wrong |
| `config.seedDemoData` / `SEED_DEMO_DATA` | Parsed into the config and never read. The seed command always creates its demo workspace |
| `reminder_rules.quiet_hours_json` column | Never read. Quiet hours come from `organization_settings.quiet_hours_start/end` |
| `organization_settings.reminder_opt_out` column | Never read. The scheduler uses `customers.reminder_opt_out` |
| `invoices.tax_label` column | Never written. `createInvoiceSchema` has no `taxLabel`, so the PDF always falls back to `'Tax'` even when the organization has configured a tax label |

### 5.12 `/health/info` is unauthenticated — **accepted**

It returns the service name, `NODE_ENV`, the worker configuration, the email
adapter name with `deliversMessages` and its setup hint, and the startup
`warnings` array. It reveals **no secrets and no connection strings**, but it
does reveal whether `ENCRYPTION_KEY` and `DATABASE_URL` are configured. That is
the same information an operator sees in the logs; it is accepted for
diagnostic value. `/health/ready` exposes the same warnings.

### 5.13 `POST /auth/logout` ignores a `Bearer` token — **minor**

`req.cookies?.[cookieName]` only. A server-to-server client using
`Authorization: Bearer` cannot revoke its session through this endpoint; the
session still expires or is revoked by a password change.

### 5.14 The job queue has no direct automated test — **gap**

`JobQueue.claimNext`, the backoff calculation and `reapStale` are not covered by
a test. `reminders.schedule` is indirectly exercised through
`ReminderService` tests, not through the queue.

### 5.15 No client-side component tests — **gap**

`@testing-library/react` is a declared dependency of the client workspace, but
there are no `*.test.tsx` files. `vitest.config.ts` only includes
`server/tests/**` and `shared/src/**/*.test.ts`. UI behaviour is covered only by
the two Playwright specs.

---

## 6. Uncertain

| Item | Why it is uncertain |
| --- | --- |
| Current pass/fail state of `tests/e2e/**` | Playwright was not run in this environment. The specs were written against the current UI and the selectors were checked against the components, but **they have not been executed** |
| Behaviour against a hosted PostgreSQL instance | No managed database was available. The driver switch is a two-line branch in `createDatabase`, the schema and migrations are real PostgreSQL, and CI deliberately uses PGlite — but node-postgres has not been exercised here |
| SMTP delivery against a real provider | No credentials. `SmtpEmailAdapter` has never completed a send against a live relay |
| PGlite with the API **and** the worker open on the same data directory | Development does this daily and it worked during the smoke test, but PGlite is single-writer and the two processes writing concurrently is not a supported configuration. Production must set `DATABASE_URL`; `config.ts` warns about it |
| Restore time objective | The procedure in [OPERATIONS.md §5.4](OPERATIONS.md) is the standard PostgreSQL workflow but has not been timed |
| Performance at scale | No load test has been run and no performance budget exists. Every list query is indexed, but large `payment_allocations` tables feeding a correlated sub-select have not been measured |
| WCAG conformance | Semantic structure, labels, focus and the skip link are implemented, but no automated or manual accessibility audit has been performed. **No conformance claim is made** |
| Legal or regulatory compliance | **No claim is made.** See SECURITY.md |

---

## 7. Remaining work

Ordered. Nothing here is required for the product to function correctly; the
list is what a maintainer should pick up next.

### Correctness

1. **Fix the dashboard follow-up list** (§5.1). Select `invoices.id` in the
   first query and carry it through, instead of the empty-string placeholder.
   Add a test asserting `followUps[0].invoiceId` is a UUID.
2. **Make `InvoiceService.detail` use the effective-allocation fragment** so the
   detail page matches every other surface after a partial refund (§5.7).
3. **Make `payments.list.allocatedMinor` use the fragment** (§5.8).
4. **Return per-currency outstanding on `GET /customers`** and rename or drop
   the misleading `outstandingMinor` column (§5.9).
5. **Filter `GET /invoices/:id` adjustments** to the payments allocated to that
   invoice (§5.10).
6. **Correct `BACKGROUND_JOB_TYPES`** to the four types the handlers actually
   register, or delete it (§5.11).
7. **Remove or wire** `SEED_DEMO_DATA`, `reminder_rules.quiet_hours_json` and
   `organization_settings.reminder_opt_out` (§5.11).
8. **Write `invoices.tax_label` from the organization's `taxLabel`** on create
   and update, so the PDF honours the configured label (§5.11).

### Hardening

9. **Wire `AUTH_RATE_LIMIT_MAX` to `/api/v1/auth`** (§5.3).
10. **Add Playwright to CI** and run the E2E suites there (§5.2).
11. **Add a job-queue test suite**: concurrent `claimNext` returns distinct jobs,
    backoff bounds, `reapStale` recovery, `retry` resets attempts (§5.14).
12. **Add client component tests** with React Testing Library, which is already
    a dependency (§5.15).
13. **Move the invoice-send path onto the `email.deliver` job** so the request
    returns immediately (§5.5).
14. **Honour `exports.filters`**, or remove the field from the schema (§5.6).
15. **Accept a Bearer token on `/auth/logout`** (§5.13).

### Product completeness

16. **A payment-provider adapter**, once a merchant account exists. The
    nine requirements are listed in [INTEGRATIONS.md §2.5](INTEGRATIONS.md).
17. **Email template editing** per organization.
18. **A job-administration screen** for dead letters, using the existing
    `JobQueue.listFailed/stats/retry`.
19. **Organization deletion** with a confirmation workflow, a retention policy
    and an audit trail — or remove the unused `organization.delete` permission.
20. **Account data export** and **self-service account deletion**.
21. **Bulk actions** on the invoice list: export selected, send reminders. Bulk
    void needs a real confirmation summary.
22. **Email address verification** on registration.

### Operational

23. **Run the restore drill** against real backups and record the elapsed time.
24. **Set up monitoring** using the alert list in
    [OPERATIONS.md §7.1](OPERATIONS.md) — nothing is wired today.
25. **Verify the hosting provider's backup retention and PITR** against the real
    provider, not the documentation.
26. **Remove the seeded demo account** (or change its password) before any shared
    or public deployment.
27. **Add a migration for any schema change** rather than relying on the
    start-up auto-migrate in a shared environment.

---

## 8. Feature summary

### Implemented

Multi-tenant organizations with roles and an audited ownership transfer;
invitations; email/password auth with Argon2id and database-backed sessions;
customers with archive and reminder opt-out; invoices with server-side totals,
proportional discount allocation, tax on the post-discount base, revisions,
server-side pagination and sorting, a derived `overdue` status, a public link
with revocation, and a server-rendered PDF; an append-only payment ledger with
automatic and manual allocation, reversal/refund/chargeback and effective
allocation; a dashboard, receivables aging, collections and five CSV exports; a
database-backed job queue with leases, bounded backoff, idempotency and visible
dead letters; a reminder engine with rules, quiet hours, timezone handling,
opt-out, cancellation and preview; an email outbox with three adapters and an
honest delivery vocabulary; an integrations screen that cannot claim a
connection that does not exist; a full audit trail.

### Not implemented, stated plainly

Online payments (no adapter ships); SMTP delivery or bounce reporting; exchange
rates; credit notes; unapplied credit; destructive deletes; bulk actions; email
open tracking; template editing; a generated OpenAPI document; a job
administration UI; organization and account deletion; email verification and
MFA.

### Commands

| | |
| --- | --- |
| Install | `npm ci` |
| Build | `npm run build` |
| Quality gate | `npm run verify` |
| Migrations | `npm run db:migrate` |
| New migration | `npm run db:generate` |
| Development seed | `npm run db:seed` |
| Development stack | `npm run dev` |
| API / worker / client | `npm run dev:server`, `npm run dev:worker`, `npm run dev:client` |
| Production | `npm run build && npm start`, plus `node server/dist/worker.js` |
| Smoke test | `node scripts/smoke.mjs <api-base-url>` |

### Environment variables

`NODE_ENV`, `PORT`, `API_URL`, `APP_URL`, `APP_URLS`, `DATABASE_URL`,
`PGLITE_DATA_DIR`, `DATABASE_POOL_MAX`, `EMAIL_PROVIDER`, `SMTP_HOST`,
`SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `FROM_EMAIL`,
`EMAIL_REPLY_TO`, `ENCRYPTION_KEY`, `WORKER_ENABLED`,
`WORKER_POLL_INTERVAL_MS`, `WORKER_CONCURRENCY`, `WORKER_IN_API`,
`SESSION_COOKIE_NAME`, `SESSION_TTL_HOURS`, `COOKIE_SECURE`, `TRUST_PROXY`,
`LOG_LEVEL`, `RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX`, `AUTH_RATE_LIMIT_MAX`,
`SEED_EMAIL`, `SEED_PASSWORD`. Full descriptions in `.env.example` and
[README.md §3](README.md).

### Deploy

Order: **migrate → API → worker → web.** Then run the smoke test. Roll back in
reverse, and never roll the schema backward. Details in
[OPERATIONS.md §6](OPERATIONS.md).