# CollectFlow — Architecture

How the system is put together, where the code lives, and the two engineering
rules this codebase exists to enforce.

---

## 1. Shape of the system

Three long-lived processes and one PostgreSQL database.

```
                  browser
                     |
        cookie: collectflow_session
                     |
   +-----------------v-------------------+
   |  client  (React + Vite, static)     |   :5173 dev, static host in prod
   |  /api/v1/* is same-origin (proxied |
   |  in dev by Vite)                     |
   +-----------------+-------------------+
                     |
   +-----------------v-------------------+
   |  api     (Express, :4000)            |   reads .env-style env vars
   |  routes -> services -> Drizzle       |
   +---------+-------------------+-------+
             |                   |
   +---------v--------+  +-------v-------------------+
   | worker (Node)    |  | database (PostgreSQL 16)  |
   | jobs/queue.ts    |  |  Drizzle schema           |
   | jobs/worker.ts   |  |  drizzle/*.sql migrations |
   +------------------+  +---------------------------+
```

There is no message broker, no cache server, no microservices split and no
event streaming. Background work is a table in the same database and a second
process that reads it.

---

## 2. Technology

| Layer | Choice | Note |
| --- | --- | --- |
| Language | TypeScript 5.7, `strict` | one tsconfig per workspace |
| Runtime | Node.js ≥ 20.11 | verified on 24.20.0 |
| Frontend | React 18 + Vite 6 + React Router 6 + TanStack Query 5 + Tailwind CSS 4 | tokens in `client/src/styles/tokens.css` |
| API | Express 4 | routers under `server/src/http/routes/` |
| Validation | Zod 3 | schemas in `shared/`, re-run on the server |
| ORM | Drizzle ORM 0.45 | one schema, real SQL migrations |
| Database | PostgreSQL via node-postgres; PGlite for development/CI | one schema, one migration set |
| Auth | Argon2id (`@node-rs/argon2`) + database-backed opaque sessions | no hand-rolled crypto |
| Jobs | `background_jobs` table + a worker process | `FOR UPDATE SKIP LOCKED` leases |
| Email | Nodemailer (SMTP), plus `disabled` and `log` adapters | adapter contract in `server/src/integrations/email/types.ts` |
| PDF | pdfkit | rendered in-process from persisted rows |
| Logging | Pino, JSON, ISO timestamps | redaction configured in `server/src/logger.ts` |
| Tests | Vitest (unit + integration), Playwright (E2E), Supertest (HTTP) | |
| CI | GitHub Actions, `npm ci` + `npm run verify` + migrate + seed | `.github/workflows/ci.yml` |

npm workspaces: `shared`, `server`, `client`. `@collectflow/shared` is compiled
first; both the API and the web client import from it.

---

## 3. Module map

Real paths, relative to the repository root.

### 3.1 `shared/src` — compiled once, used twice

| File | Responsibility |
| --- | --- |
| `money.ts` | Minor-unit parse/format, `multiplyMinor`, `applyBasisPoints`, currency exponents, `groupByCurrency` |
| `invoice-totals.ts` | `calculateInvoiceTotals`, `allocateProportionally` (largest remainder), `normalizeQuantity` |
| `constants.ts` | Roles, permissions, invoice/payment/reminder status vocabularies, aging buckets, page-size caps, `deriveDisplayStatus` |
| `schemas.ts` | Every Zod request schema, shared by the browser and the API |
| `api.ts` | `Paginated<T>`, `ApiErrorBody`, `SessionUser`, `MembershipSummary` |
| `dates.ts` | Timezone-aware date helpers (`todayIso`, `addDaysIso`, `daysBetweenIso`, `zonedWallClockToUtc`, `minutesSinceMidnightInZone`) |
| `csv.ts` | `escapeCsvCell` (formula-injection safe), `toCsv`, `parseCsv` |

This package is pure: no database, no Express, no React. That is what lets the
browser preview and the server persistence agree by construction.

### 3.2 `server/src` — the API and the worker

| File | Responsibility |
| --- | --- |
| `index.ts` | API process entry: config → database → migrations → services → app → listen |
| `worker.ts` | Worker process entry: config → database → migrations → services → `startWorker` |
| `app.ts` | Express assembly: Helmet, CORS allow-list, body parsers, request context, `/api/v1` rate limit, router, 404, error handler |
| `config.ts` | Zod-validated environment; fails fast with a readable message; collects startup warnings |
| `container.ts` | `createServices()` — one instance per process; also `createEmailAdapter()` |
| `errors.ts` | `AppError` plus typed constructors mapped to the documented envelope |
| `logger.ts` | Pino factory, redaction paths, `SENSITIVE_KEYS`, `redactObject` |

**Database**

| File | Responsibility |
| --- | --- |
| `db/schema.ts` | The whole Drizzle schema: 23 tables, indexes, unique constraints, relations |
| `db/client.ts` | `createDatabase()` — node-postgres **or** PGlite behind one `DatabaseHandle`; `runMigrations()` |
| `db/balance-sql.ts` | **The single definition of effective allocation** (§6, rule 2) |
| `db/migrate-cli.ts` | `npm run db:migrate` |
| `db/seed.ts` | `npm run db:seed`; refuses to run in production |

**HTTP**

| File | Responsibility |
| --- | --- |
| `http/routes/index.ts` | Router tree, `notFoundHandler`, `errorHandler` |
| `http/routes/auth.ts` | Register, login, logout, session, profile, password, organizations, invitations |
| `http/routes/organization.ts` | Organization, invoice settings, members, invitations, transfer ownership, audit, customer archive |
| `http/routes/customers.ts` | List, options, create, detail, update, reminder opt-out |
| `http/routes/invoices.ts` | List, create, detail, update, send, duplicate, void, revoke public link, PDF |
| `http/routes/payments.ts` | List, record manual, allocate, adjustments |
| `http/routes/integrations.ts` | Status list, save, test, send test email, disconnect |
| `http/routes/reporting.ts` | Dashboard, receivables, collections, exports, reminder rules/logs/outbox/preview |
| `http/routes/public.ts` | `GET /public/invoices/:token`, rate limited |
| `http/routes/webhooks.ts` | `POST /webhooks/payments/:provider` — refuses without an adapter |
| `http/routes/health.ts` | `/health/live`, `/health/ready`, `/health/info` |
| `http/middleware.ts` | `requestContext`, `requireAuth`, `requireAuthenticated`, `requireOrganization`, `requirePermission`, `asyncHandler` |
| `http/validate.ts` | `validate({ body, query, params })` — Zod, with a per-field error map |

**Services** (`server/src/services/`)

| File | Responsibility |
| --- | --- |
| `auth.service.ts` | Users, sessions, password reset, memberships |
| `organization.service.ts` | Organizations, membership, invitations, settings, reminder-rule defaults, ownership transfer |
| `customer.service.ts` | CRUD, archive, reminder opt-out, detail with invoices/payments/outstanding/timeline |
| `invoice.service.ts` | Totals, numbering, lifecycle, revisions, public token, `recomputeStatus` |
| `payment.service.ts` | Manual recording, allocation, adjustments, provider deduplication |
| `reminder.service.ts` | Scheduling, idempotency, quiet hours, cancellation, preview |
| `report.service.ts` | Dashboard summary, receivables aging, collections |
| `export.service.ts` | CSV for five datasets |
| `email.service.ts` | Outbox: queue, deliver, stats, template seeding |
| `integration.service.ts` | Truthful status, encrypted credential storage, verification probes |
| `audit.service.ts` | Audit writes with redaction; audit list; per-entity timeline |

**Integrations, jobs, PDF, crypto**

| File | Responsibility |
| --- | --- |
| `integrations/email/types.ts` | The adapter contract: `deliversMessages`, `accepted`, failure codes |
| `integrations/email/smtp.ts` | Nodemailer; classifies `EAUTH`/`ECONNECTION`/`EDNS`/… into failure codes |
| `integrations/email/disabled.ts` | Default; `verifyConfiguration` → not ok; `send` → `not_configured` |
| `integrations/email/log.ts` | Development only; writes `.eml` files to `server/.data/outbox` |
| `integrations/email/templates.ts` | Allow-listed placeholders, HTML escaping, plain-text derivation |
| `jobs/queue.ts` | `enqueue`, `claimNext`, `markSucceeded`, `markFailed`, `reapStale`, `cancel`, `retry`, `listFailed`, `stats` |
| `jobs/worker.ts` | Poll loop, concurrency, stale-lease reaper, recurring enqueue |
| `jobs/handlers.ts` | `email.deliver`, `reminders.schedule`, `invoices.reconcile`, `maintenance.cleanup` |
| `pdf/invoice-pdf.ts` | `loadInvoiceForPdf`, `renderInvoicePdf` |
| `lib/crypto.ts` | Argon2id, `randomToken`, `sha256Hex`, `hmacSha256Hex`, `safeEqual`, `sealCredentials`/`openCredentials`, `maskSecret` |
| `lib/util.ts` | `slugify`, `uniqueSlug`, `escapeHtml`, date helpers, `clampPage` |

### 3.3 `client/src` — the web app

| File | Responsibility |
| --- | --- |
| `main.tsx` | React root, providers |
| `routes.tsx` | Route tree: `/login`, `/register`, `/forgot-password`, `/reset-password`, `/accept-invitation`, `/welcome`, `/:organizationId/*`, `/public/invoices/:token` |
| `components/AppShell.tsx` | Sidebar, header, organization switcher, profile menu, mobile drawer, skip link |
| `components/ui.tsx` | `Card`, `Button`, `Field`, `Input`, `Badge`, `PageHeader`, `EmptyState`, table primitives |
| `components/patterns.tsx` | `MetricCard`, `DataTable`, `FilterBar`, `ConfirmDialog`, `ActivityTimeline`, `StatusBadge`, `CopyButton` |
| `components/Modal.tsx`, `components/Toast.tsx` | Focus-managed dialog, transient notifications |
| `lib/api.ts` | `apiFetch`/`apiDownload`, `ApiError`; `credentials: 'include'`; nothing in `localStorage` |
| `lib/session.tsx` | `SessionProvider`, session bootstrap, organization switching, `usePermission` |
| `pages/*.tsx` | Dashboard, Invoices, InvoiceEditor, InvoiceDetail, Customers, CustomerDetail, Payments, Reports, Reminders, Integrations, Settings, PublicInvoice, auth pages, NotFound |
| `styles/tokens.css` | Design tokens (spacing, colour, radius, focus) |

The client is a static bundle. It never receives a server secret; the only
`VITE_`-prefixed variable in the repository is `VITE_API_PROXY`, and it is read
by `client/vite.config.ts` (build/dev config), not shipped to the browser.

---

## 4. Data flow

### 4.1 A write request

```
browser
  │  POST /api/v1/<orgId>/invoices   (cookie, JSON)
  ▼
helmet → cors allow-list → body parser → requestContext (request id)
  ▼
/api/v1 rate limiter
  ▼
requireAuth        → session cookie → SHA-256 → sessions row → principal
requireAuthenticated
  ▼
/:<organizationId>  → requireOrganization → membership check → permissions
  ▼
validate({ body, query, params })   Zod; 400 with a field→messages map
  ▼
requirePermission('invoice.create')  → 403 if the role lacks it
  ▼
router → InvoiceService.create
  │    calculateInvoiceTotals(...)                     (shared)
  │    db.transaction:
  │      UPDATE invoice_sequences … RETURNING          (number)
  │      INSERT invoices
  │      INSERT invoice_items
  │      INSERT invoice_revisions
  ▼
audit_events                                        (separate write)
  ▼
201 { invoice, email? }
```

### 4.2 A background job

```
reminders.schedule job (per organization, every 15-minute bucket)
  ▼
ReminderService.scheduleDueReminders
  │  open invoices × enabled rules
  │  skip: opted out, no email, no due date, outside horizon/grace
  │  INSERT reminder_logs … ON CONFLICT (idempotency_key) DO NOTHING
  ▼
for each new candidate:
  EmailService.queueInvoiceEmail   → email_messages row (idempotent)
  JobQueue.enqueue('email.deliver') keyed by messageId
  ▼
worker claims → EmailService.deliver → adapter.send
  │  accepted  → email_messages.status = 'sent', provider_message_id, sent_at
  │             reminder_logs.status = 'sent'
  │  rejected  → failure_code + redacted message, retryable or permanent
  ▼
JobQueue.markSucceeded | markFailed (backoff | dead-letter)
```

### 4.3 A background claim

```sql
UPDATE background_jobs
   SET status='running', locked_at=now(), locked_by=$worker, attempts=attempts+1
 WHERE id = (SELECT id FROM background_jobs
              WHERE status='queued' AND run_after <= now()
              ORDER BY run_after ASC, created_at ASC
              FOR UPDATE SKIP LOCKED
              LIMIT 1)
RETURNING …
```

The claim and the status change happen in one transaction. `SKIP LOCKED` means
several workers can drain the same queue without ever handing the same job to
two of them.

---

## 5. Database drivers

Two drivers, one schema, one migration set.

| Driver | Selected when | Used for |
| --- | --- | --- |
| `pg` (node-postgres) + `drizzle-orm/node-postgres` | `DATABASE_URL` is set | Managed PostgreSQL, production |
| `@electric-sql/pglite` + `drizzle-orm/pglite` | `DATABASE_URL` is empty | Local development, tests, CI |

PGlite is an embedded, file-backed **PostgreSQL 16** build running as WebAssembly
in the same process. It executes real PostgreSQL SQL, so the migrations, foreign
keys, unique indexes, `bigint`, `numeric`, transactions and `FOR UPDATE SKIP
LOCKED` all behave identically. This is why `server/tests/**` can assert
transactional invoice numbering and tenant isolation without a server.

`server/drizzle/0000_redundant_leech.sql` and `server/drizzle/meta/` are the
**only** schema definition. `drizzle.config.ts` uses `dialect: 'postgresql'`;
`drizzle-kit generate` only writes SQL and needs no live database. The
application applies migrations itself through `runMigrations()` so the identical
code path serves both drivers.

PGlite specifics:

- Data directory: `PGLITE_DATA_DIR`, resolved relative to `process.cwd()`,
  which for npm workspace scripts is `server/` — so the default is
  `server/.data/pgdata`.
- `memory: true` gives a fully ephemeral instance; that is what the test harness
  uses.
- **One writer.** The API and the worker cannot both open the same PGlite
  directory. Development runs both against it today and works, but production
  must set `DATABASE_URL`. `config.ts` emits a startup warning saying exactly
  that whenever `DATABASE_URL` is missing.
- TLS is enabled for node-postgres unless the host is localhost/127.0.0.1/[::1]
  or the URL contains `sslmode=disable`.
- The connection string is redacted before it reaches the log.

Schema summary (23 tables): `organizations`, `users`, `memberships`,
`sessions`, `invitations`, `password_reset_tokens`, `organization_settings`,
`customers`, `invoice_sequences`, `invoices`, `invoice_items`,
`invoice_revisions`, `payments`, `payment_allocations`, `payment_adjustments`,
`reminder_rules`, `reminder_logs`, `email_templates`, `email_messages`,
`integrations`, `webhook_events`, `audit_events`, `background_jobs`.

UUID primary keys throughout; `timestamptz` for instants and `date` for calendar
dates. Every tenant-owned table has a non-null `organization_id` with an index.

---

## 6. Two rules learned from real defects in this build

### Rule 1 — Never issue a query on the outer database handle from inside a `db.transaction()` callback

**The defect.** `PaymentService.addAdjustment` inserted the payment, wrote the
adjustment, recomputed the affected invoices and then called
`this.audit.record(...)`. `AuditService` holds its own reference to `this.db` —
the *outer* handle, not the transaction handle. On node-postgres the insert ran
on a **different pooled connection**, outside the open transaction. The audit
row committed independently, so a rollback of the adjustment would leave an
audit event claiming a reversal that never happened. On PGlite, which serves one
connection, the nested query deadlocked against the transaction already holding
it, and the request hung until it timed out. The bug appeared only under PGlite,
which is why it survived an earlier round of testing against a pooled server.

**The rule.** Inside a transaction callback, **every** query must go through the
`tx` handle the callback receives — including writes made by helper services.
Passing `tx` down, or inlining the insert, is mandatory. A transaction callback
must not reach for `this.db` anywhere, including for audit and for reads that
look harmless.

**Where it is now enforced.** The comment sits at the exact site
(`server/src/services/payment.service.ts`, `addAdjustment`), and the audit insert
uses `tx.insert(auditEvents)`. `recordManual` does the same. The services that
are called *inside* a transaction take `tx` explicitly:
`InvoiceService.recomputeStatus(tx, organizationId, invoiceId)`.

### Rule 2 — Always re-derive balances from the same SQL fragment

**The defect.** Balances were initially computed in more than one place: the
invoice list summed raw allocations in JavaScript, the dashboard summed them in
another query, and the CSV export computed `total − allocated` with its own
sub-select. After a partial refund the three answers differed by a minor unit or
two, and the public invoice page — the one customers see — could show a
different balance from the operator's own invoice list. Which number was "right"
depended on which screen you were looking at, which is worse than being
consistently wrong.

**The rule.** There is exactly one definition of an invoice's effective
allocation, and every surface re-derives from it at read time:

```ts
// server/src/db/balance-sql.ts
effectiveAllocatedSql(invoiceId, organizationId)
allocatedForInvoiceTable(organizationId)
```

No `invoices.paid_minor` column is cached and no balance is computed in the
application layer. Because the fragment is used inside the same `SELECT`/`WHERE`
clause as the invoice row, it is correct in a list, in an aggregate, in a
`GROUP BY`, in a correlated sub-select, and in the invoice detail page.

The consumers, all reading the same fragment:

| Surface | Where |
| --- | --- |
| Invoice list (balance + `sort=balance_minor`) | `invoice.service.ts` `list` |
| Invoice detail balance | `invoice.service.ts` `detail` (documented exception, §note) |
| Status recomputation after a payment | `invoice.service.ts` `recomputeStatus` |
| Over-allocation validation | `payment.service.ts` `assertAllocations` |
| Automatic allocation candidate scan | `payment.service.ts` `autoAllocate` |
| Dashboard outstanding / overdue / follow-ups | `report.service.ts` `dashboard` |
| Receivables aging and by-customer | `report.service.ts` `receivables` |
| Collections customer balances | `report.service.ts` `collections` |
| Customer list outstanding, customer detail | `customer.service.ts` |
| CSV exports (invoices, aging) | `export.service.ts` |
| Public invoice page | `http/routes/public.ts` |

**Known exception, stated rather than hidden.** `InvoiceService.detail` sums
the raw allocation rows it has already loaded for its allocation list instead
of re-running the fragment, and `loadInvoiceForPdf` deliberately reports
`paidMinor = 0` and `balance = total` because an invoice document is a statement
of what was invoiced, not of what has been received. Both are the only two
divergences and both are recorded in
[PRODUCT_SPEC.md §5.3](PRODUCT_SPEC.md).

---

## 7. Tenancy enforcement

Enforced in five layers, in this order:

1. **Routing.** Every tenant route is mounted under
   `/:organizationId/...` behind `requireOrganization`
   (`server/src/http/routes/index.ts`).
2. **Membership.** `requireOrganization` calls
   `OrganizationService.requireMembership(organizationId, userId)`. A missing
   membership, a non-`active` membership, a deleted organization and a
   non-existent organization all raise the identical `404`. The API cannot be
   used to enumerate other tenants' identifiers.
3. **Permissions.** `requirePermission(permission)` compares against
   `permissionsForRole(role)` from `shared/src/constants.ts`. A role that lacks
   the permission gets `403` with the missing permission named.
4. **Query scoping.** Every service method takes `organizationId` as its first
   argument and puts `eq(table.organizationId, organizationId)` in the `WHERE`
   clause. There is no "find by id" that omits the tenant predicate.
5. **Tests.** `server/tests/domain.test.ts` and `server/tests/api.test.ts` assert
   cross-tenant `404`s, blocked cross-tenant payment allocation, and that one
   tenant's invoice list never contains another's ids.

The `organizationId` in the URL is treated as an untrusted hint, never as
authority. Switching organization also requires membership
(`POST /auth/organizations/:organizationId/switch` re-checks before moving the
session pointer).

---

## 8. Background job model

| Property | Implementation |
| --- | --- |
| Storage | `background_jobs`: `status`, `attempts`, `max_attempts` (5), `run_after`, `locked_at`, `locked_by`, `completed_at`, `last_error_code`, `last_error_message`, `idempotency_key` |
| Claim | `FOR UPDATE SKIP LOCKED` inside a transaction — see §4.3 |
| Concurrency | `WORKER_CONCURRENCY` (default 3) claims per drain pass |
| Poll | `WORKER_POLL_INTERVAL_MS` (default 2000 ms) when the queue was empty |
| Lease recovery | `reapStale(300_000)` every 60 s returns `running` rows with an expired lease to `queued` |
| Retry | `markFailed(retryable: true)` sets `run_after = now + backoff + jitter` and status back to `queued` |
| Backoff | `min(5000 × 2^(attempts−1), 15 min)` plus `random(0, min(backoff, 30 s))` of jitter |
| Exhaustion | `attempts >= max_attempts`, or a non-retryable error → `failed` with the error code and a 500-character message, **left visible** |
| Manual retry | `JobQueue.retry(jobId)` resets `attempts` and `run_after`; `listFailed()` and `stats()` surface the dead letters |
| Idempotency | Partial unique index on `idempotency_key`; `enqueue` returns `{ deduplicated: true }` and the existing id |
| Recurring | Every 15 minutes with a bucket-stamped key, so a restart never duplicates: `maintenance.cleanup:<bucket>`, `reminders.schedule:<org>:<bucket>`, `invoices.reconcile:<org>:<bucket>` |
| Handlers | `email.deliver`, `reminders.schedule`, `invoices.reconcile`, `maintenance.cleanup` |

Handlers return `{ retryable, code, message }`. `email.deliver` treats a
"not configured" provider as **permanent** (no point retrying until an operator
fixes the environment) and everything else as retryable. An unknown job type
fails immediately with `retryable: false`.

Every handler is idempotent: re-running it produces no additional rows because
of the unique idempotency keys.

---

## 9. Security boundaries

| Boundary | Mechanism |
| --- | --- |
| Browser ↔ API | HTTPS (deployment assumption), HTTP-only `SameSite=Lax` session cookie, Helmet headers, `default-src 'none'` CSP, `frame-ancestors 'none'`, `no-referrer`, CORS allow-list of `APP_URL` + `APP_URLS` with credentials |
| Tenant ↔ tenant | §7 |
| API ↔ database | `DATABASE_URL` only; parameterised Drizzle queries; the URL is redacted in logs |
| Server ↔ network | The server makes outbound connections **only** to the database and the SMTP relay, both operator-configured. It never fetches a user-supplied URL — see SECURITY.md §5 |
| Server ↔ secrets | Environment variables. `ENCRYPTION_KEY` seals integration credentials with AES-256-GCM; only masked values ever leave the process |
| Server ↔ logs | Pino redaction paths plus `redactObject` on audit metadata; `redactUrl` on the connection string; `safeMessage` on provider errors |
| Public ↔ tenant | The public invoice route is the only unauthenticated data route. It resolves a SHA-256 token hash, honours revocation, rate-limits to 30/min and returns an explicitly constructed projection — no internal ids, no customer contact details |
| Provider ↔ server | Signature verification is **not implemented**; the webhook route records and refuses. See §10 |

---

## 10. Integration boundaries

CollectFlow ships three email adapters behind one contract
(`server/src/integrations/email/types.ts`) and **zero** payment adapters.

| Provider | State | What a real integration does here |
| --- | --- | --- |
| SMTP | Implemented (`smtp.ts`) | `verifyConfiguration` opens a real connection; `send` hands a message to Nodemailer and records `accepted` with the provider message id |
| `disabled` | Default | `verifyConfiguration` → not ok; `send` → `not_configured`. The UI shows "Not connected" |
| `log` | Development only | Writes `.eml` files to `server/.data/outbox`; `deliversMessages = false`; the API refuses to start with it in production |
| Payment provider | **Boundary only** | Storage, AES-256-GCM encryption, masked display, a verify action that honestly answers "cannot verify a provider it has no credentials for", and a webhook route that records and returns `503`. No SDK, no signature verification, no payment creation |

The contract deliberately separates three concepts that are easy to conflate:
*configured* (credentials exist), *deliversMessages* (a real provider will try),
and *accepted* (the provider took this specific message). An accepted message is
never reported as delivered.

---

## 11. Testing strategy

| Layer | Tool | Location | Database |
| --- | --- | --- | --- |
| Pure domain maths | Vitest | `server/tests/money.test.ts` | none |
| Domain + persistence | Vitest | `server/tests/domain.test.ts` | in-memory PGlite, real migrations |
| HTTP + tenancy + envelope | Vitest + Supertest | `server/tests/api.test.ts` | in-memory PGlite |
| E2E journeys | Playwright | `tests/e2e/` | the seeded development database, against `npm run dev` |
| CI | GitHub Actions | `.github/workflows/ci.yml` | PGlite, `DATABASE_URL: ''` |

`vitest.config.ts` sets `fileParallelism: false` and `pool: 'forks'` so several
embedded PostgreSQL instances do not saturate the machine. The harness
(`server/tests/harness.ts`) sets `NODE_ENV=test`, `EMAIL_PROVIDER=disabled`,
`WORKER_ENABLED=false`, `LOG_LEVEL=silent`, and never reads production
credentials.

`npm run verify` is the local gate: shared build → server type-check → client
type-check → lint → tests → production build.

---

## 12. Deliberate non-goals

Not oversights; decisions.

- No exchange rates or multi-currency conversion. Amounts are grouped per
  currency.
- No credit notes or negative lines. Credits are `payment_adjustments`.
- No card storage, no payment initiation, no custody of funds.
- No unapplied-credit bucket. Over-allocation is refused with an explanation.
- No email open tracking, so no "viewed" timeline event.
- No microservice split, message broker, cache or event streaming.
- No generated OpenAPI document; `docs/API.md` is maintained by hand.