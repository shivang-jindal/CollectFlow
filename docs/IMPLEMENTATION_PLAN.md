# CollectFlow — Implementation Plan

The plan from the build specification (Part G / G1, Phases 0–7) **as actually
executed**, with the real file paths that each phase produced. It is written in
the past tense because the work is done; where a phase deliberately stopped
short, that is stated rather than hidden.

MVP boundary followed (G5): organizations/auth → customers → invoices and PDF →
manual payments and allocations → dashboard and aging report → email reminders.
A payment-provider adapter was built "only if account credentials are available"
— they were not, so the boundary ships and is labelled. See
[INTEGRATIONS.md](INTEGRATIONS.md).

---

## Phase 0 — Repository and product plan

**Goal.** Decide the stack, the schema, the environment variables and the first
end-to-end journey before writing product code.

| Decision | Choice | Where it is recorded |
| --- | --- | --- |
| Repository layout | npm workspaces: `shared`, `server`, `client` — no monorepo framework | `package.json` `workspaces` |
| Server | Node + TypeScript + Express 4 | `server/package.json` |
| ORM | **Drizzle** (not Prisma), one schema, real SQL migrations | `server/src/db/schema.ts`, `server/drizzle/` |
| Database drivers | node-postgres in production, PGlite embedded for dev/CI — one schema, one migration set | `server/src/db/client.ts` |
| Money | Integer minor units, half away from zero, per-currency grouping | `shared/src/money.ts` |
| Auth | Argon2id + database-backed opaque sessions. No hand-rolled hashing or token signing | `server/src/lib/crypto.ts`, `server/src/services/auth.service.ts` |
| Background work | `background_jobs` table + a separate worker process | `server/src/jobs/` |
| Email | Adapter boundary with `disabled`, `log` and `smtp` | `server/src/integrations/email/` |
| Validation | Zod schemas shared between browser and server | `shared/src/schemas.ts` |
| Tests | Vitest + Supertest + Playwright | `vitest.config.ts`, `playwright.config.ts` |

Produced:

- `.env.example` — every variable with a safe placeholder and a comment
  explaining the consequence of leaving it empty.
- `package.json` scripts: `build`, `build:shared`, `typecheck`, `lint`, `test`,
  `test:watch`, `test:e2e`, `db:generate`, `db:migrate`, `db:seed`,
  `dev:server`, `dev:client`, `dev:worker`, `dev`, `start`, `verify`.
- `eslint.config.mjs`, `tsconfig.json` per workspace, `.gitignore`.

The first journey chosen: **create a customer → create an invoice → send it (or
download the PDF) → record a manual payment → see the dashboard balance change.**
Every later phase was checked against it.

---

## Phase 1 — Foundation

**Goal.** Database and migrations, auth, tenancy, the request pipeline, and the
shared shell.

| Work | Files |
| --- | --- |
| 23-table schema with UUID keys, `timestamptz`, indexes, unique constraints and partial unique indexes | `server/src/db/schema.ts` |
| Driver factory, migration runner | `server/src/db/client.ts` (`createDatabase`, `runMigrations`) |
| First real SQL migration + journal | `server/drizzle/0000_redundant_leech.sql`, `server/drizzle/meta/_journal.json` |
| Environment validation that fails fast with a secret-free message | `server/src/config.ts` (`loadConfig`) |
| Typed errors mapped to the documented envelope | `server/src/errors.ts` |
| Structured logging with redaction | `server/src/logger.ts` |
| Express assembly: Helmet, CORS allow-list, body limits, request ids, rate limit, error handler | `server/src/app.ts`, `server/src/http/routes/index.ts` |
| Middleware chain: `requestContext`, `requireAuth`, `requireAuthenticated`, `requireOrganization`, `requirePermission` | `server/src/http/middleware.ts` |
| Zod request validation | `server/src/http/validate.ts`, `shared/src/schemas.ts` |
| Health routes | `server/src/http/routes/health.ts` |
| Auth service, session issuance and revocation, password reset | `server/src/services/auth.service.ts` |
| Crypto helpers | `server/src/lib/crypto.ts` |
| Organization, membership, invitations, settings | `server/src/services/organization.service.ts` |
| Roles, permissions, status vocabularies | `shared/src/constants.ts` |
| React Router tree, `AppShell`, sidebar, organization switcher, skip link | `client/src/routes.tsx`, `client/src/components/AppShell.tsx` |
| API client with cookie credentials only | `client/src/lib/api.ts` |
| Tenant-isolation tests | `server/tests/api.test.ts`, `server/tests/domain.test.ts` |
| CI | `.github/workflows/ci.yml`, `vitest.config.ts` |

Two tenancy decisions fixed here and never revisited: a non-member receives the
**same `404`** as a non-existent organization, so the API cannot be used to probe
for foreign ids; and `requireOrganization` re-checks membership on every tenant
request rather than trusting the id in the URL.

---

## Phase 2 — Core data journey

**Goal.** Customers and invoices end to end, with list/search/filter/pagination
and audit logging, before any analytics.

| Work | Files |
| --- | --- |
| Money primitives and invoice totals (shared) | `shared/src/money.ts`, `shared/src/invoice-totals.ts` |
| Customer CRUD, archive, reminder opt-out, derived outstanding | `server/src/services/customer.service.ts` |
| Customer routes | `server/src/http/routes/customers.ts` |
| Invoice create/update with server-side recalculation and revision snapshots | `server/src/services/invoice.service.ts` |
| Transactional invoice numbering | `allocateInvoiceNumber` in `server/src/services/invoice.service.ts` |
| Public token issuance, SHA-256 storage, revocation | `randomToken` / `sha256Hex`, `findByPublicToken` |
| Invoice list with status filters, sorting and pagination | `InvoiceService.list` |
| Invoice routes | `server/src/http/routes/invoices.ts` |
| Audit service with metadata redaction | `server/src/services/audit.service.ts` |
| Invoice editor with a live preview from the shared calculator | `client/src/pages/InvoiceEditor.tsx` |

The server never accepts a client-computed total: `createInvoiceSchema` has no
total fields, and `InvoiceService.create` recalculates from the persisted line
items inside the same transaction that allocates the invoice number.

---

## Phase 3 — Domain engine

**Goal.** The part of the product that must be right: money, the ledger and
invoice state.

| Work | Files |
| --- | --- |
| Half-away-from-zero rounding at every monetary step | `multiplyMinor`, `applyBasisPoints`, `parseToMinor` in `shared/src/money.ts` |
| Proportional invoice-level discount allocation with the largest-remainder method | `allocateProportionally` in `shared/src/invoice-totals.ts` |
| Tax recomputed on the post-discount net base | `calculateInvoiceTotals` step 4 |
| Reconciliation assertion `subtotal − discount + tax === total` | `calculateInvoiceTotals` step 6 |
| **The effective-allocation SQL** | `server/src/db/balance-sql.ts` |
| Append-only ledger: payments, allocations, adjustments | `server/src/services/payment.service.ts` |
| Automatic oldest-first allocation with an explicit refusal on over-payment | `PaymentService.autoAllocate` |
| Allocation validation (tenant, customer, currency, void, balance) | `PaymentService.assertAllocations` |
| Reversal recalculation of every affected invoice | `PaymentService.addAdjustment` |
| Provider-transaction deduplication | `PaymentService.recordProviderPayment` + `payments_provider_txn_idx` |
| Status recomputation from the derived balance | `InvoiceService.recomputeStatus` |
| Stored lifecycle vs derived `overdue` | `INVOICE_STATUSES`, `deriveDisplayStatus` in `shared/src/constants.ts` |
| Void policy and the reversal-first workflow | `InvoiceService.voidInvoice` |
| Domain tests | `server/tests/domain.test.ts`, `server/tests/money.test.ts` |

**Rule 1 emerged here.** `addAdjustment` originally wrote its audit event
through the outer database handle from inside a transaction. That silently broke
atomicity on node-postgres and deadlocked on PGlite. The fix and the comment live
at `server/src/services/payment.service.ts`, `addAdjustment`.

**Rule 2 emerged here too.** Balances were initially computed in several places
and disagreed after a partial refund. `server/src/db/balance-sql.ts` was created
to be the single definition, and every reader was changed to use it.

---

## Phase 4 — Jobs and integrations

**Goal.** A real queue, a real worker, and one real integration behind an honest
boundary.

| Work | Files |
| --- | --- |
| Queue: enqueue, claim, succeed, fail, reap, cancel, retry, stats | `server/src/jobs/queue.ts` |
| `FOR UPDATE SKIP LOCKED` claim inside one transaction | `JobQueue.claimNext` |
| Bounded exponential backoff with jitter | `JobQueue.markFailed` |
| Worker loop, concurrency, stale-lease reaper, recurring enqueue | `server/src/jobs/worker.ts` |
| Handlers: `email.deliver`, `reminders.schedule`, `invoices.reconcile`, `maintenance.cleanup` | `server/src/jobs/handlers.ts` |
| Worker process entry | `server/src/worker.ts` |
| Email adapter contract | `server/src/integrations/email/types.ts` |
| SMTP adapter with failure classification | `server/src/integrations/email/smtp.ts` |
| Disabled adapter (the safe default) | `server/src/integrations/email/disabled.ts` |
| Development `log` adapter | `server/src/integrations/email/log.ts` |
| Email outbox with per-message idempotency | `server/src/services/email.service.ts` |
| Templates with an allow-listed placeholder set and HTML escaping | `server/src/integrations/email/templates.ts` |
| Reminder scheduling, quiet hours, timezone handling, opt-out, cancellation, preview | `server/src/services/reminder.service.ts` |
| Reminder routes: rules, logs, outbox, preview | `server/src/http/routes/reporting.ts` |
| Integration storage, AES-256-GCM sealing, verification probes | `server/src/services/integration.service.ts`, `server/src/lib/crypto.ts` |
| Integration routes and the Integrations screen | `server/src/http/routes/integrations.ts`, `client/src/pages/Integrations.tsx` |
| Webhook route that records and refuses | `server/src/http/routes/webhooks.ts` |

The reminder idempotency key `(organizationId, invoiceId, ruleId, targetDate)`
was chosen in this phase because it is the only key that is simultaneously
"one reminder per rule per target day" and "safe to recompute from scratch".

The payment-provider half of this phase produced the storage, encryption,
status, verification action and webhook route — and deliberately no adapter.

---

## Phase 5 — Finished UI

**Goal.** Every screen real, every state honest, every primary action wired to a
persisted record.

| Screen | Files |
| --- | --- |
| Dashboard with metric cards, recent activity, follow-ups, collection trend and inline definitions | `client/src/pages/Dashboard.tsx` |
| Invoice list with search, filters, server-side pagination and sorting | `client/src/pages/Invoices.tsx` |
| Invoice detail with timeline, allocations, adjustments, actions, public link, PDF | `client/src/pages/InvoiceDetail.tsx` |
| Customers and customer detail | `client/src/pages/Customers.tsx`, `client/src/pages/CustomerDetail.tsx` |
| Payments ledger with record/allocate/adjust | `client/src/pages/Payments.tsx` |
| Reports: aging, collections, per-currency grouping, CSV export | `client/src/pages/Reports.tsx` |
| Reminders: rules, quiet hours, preview, logs, outbox | `client/src/pages/Reminders.tsx` |
| Integrations | `client/src/pages/Integrations.tsx` |
| Settings: organization, invoice settings, members, audit | `client/src/pages/Settings.tsx` |
| Public invoice page | `client/src/pages/PublicInvoice.tsx` |
| Auth pages and the create-organization flow | `client/src/pages/*.tsx`, `client/src/pages/CreateOrganization.tsx` |
| Shared patterns: `MetricCard`, `DataTable`, `FilterBar`, `ConfirmDialog`, `ActivityTimeline`, `StatusBadge`, `CopyButton` | `client/src/components/patterns.tsx` |
| Design tokens | `client/src/styles/tokens.css` |

Honesty rules applied in this phase:

- No chart is drawn without real data; an empty series renders an explanatory
  empty state.
- `onlinePayment.available === false` renders the reason instead of a pay button.
- `sent` is labelled "sent (provider accepted)" wherever it appears.
- Dead letters and outbox failures are shown, not hidden behind a success toast.
- Every list has loading, empty, error and populated states; every form has
  validation, a loading state and a useful error.

---

## Phase 6 — Hardening

**Goal.** Test the security-relevant behaviour, make the empty-database path
real, and write the operational documentation.

| Work | Files |
| --- | --- |
| Tenant isolation over real HTTP | `server/tests/api.test.ts`, `server/tests/domain.test.ts` |
| Server-side validation and the error envelope | `server/tests/api.test.ts` |
| Public token exposure and revocation | `server/tests/api.test.ts` |
| CSV formula-injection escaping | `escapeCsvCell` assertions in `server/tests/api.test.ts`; `shared/src/csv.ts` |
| Webhook refusal | `server/tests/api.test.ts` |
| Money, rounding, discount allocation, status derivation | `server/tests/money.test.ts` |
| 360 px responsive check and the main journey | `tests/e2e/responsive.spec.ts`, `tests/e2e/journey.spec.ts` |
| Migrations on an empty database, and the seed | `.github/workflows/ci.yml` |
| Single-command quality gate | `scripts/verify.mjs` |
| Post-deployment smoke test | `scripts/smoke.mjs` |
| Operational runbook, health, backups, restore, deployment order, rollback, monitoring, incident runbook | `docs/OPERATIONS.md` |
| Security assumptions and private reporting channel | `SECURITY.md` |
| Endpoint reference | `docs/API.md` |

---

## Phase 7 — Release

**Goal.** A clean install, a full gate, a real deploy and honest documentation
of what is and is not connected.

| Step | Command | Result |
| --- | --- | --- |
| Clean install | `npm ci` | OK |
| Shared build | `npm run build:shared` | OK |
| Server + client type-check | `npm run typecheck` | OK |
| Lint | `npm run lint` | OK |
| Tests | `npm run test` | 3 files, 42 tests passed |
| Production build | `npm run build` | OK — `client/dist` 399.41 kB JS (111.84 kB gzip), 25.00 kB CSS (5.81 kB gzip) |
| Migrations on an empty embedded database | `npm run db:migrate` | OK |
| Development seed | `npm run db:seed` | OK |
| Smoke test against a running API | `node scripts/smoke.mjs` | 9 checks passed |
| Documentation | `README.md`, `SECURITY.md`, `docs/*.md` | Written from the code |

Deployment order, rollback and the incident runbook are in
[OPERATIONS.md §6](OPERATIONS.md).

---

## Deviations from the plan, and why

| Deviation | Reason |
| --- | --- |
| **No payment-provider adapter.** Boundary, storage, encryption, verification action and webhook route shipped; no SDK | Merchant account approval and credentials were unavailable. Shipping an unverified adapter would be exactly the dishonest integration the specification forbids |
| **No generated OpenAPI document.** `docs/API.md` is hand-maintained | Hand-writing it from the routers guarantees it describes the code that actually runs; a generator would need the code in a form it can consume |
| **Two additional drivers instead of one.** PGlite alongside node-postgres | Lets the entire domain and HTTP suite run against a real PostgreSQL engine with no server, on every machine and in CI |
| **A local quality-gate script** (`scripts/verify.mjs`) instead of a long command list | Makes "run everything that must pass" one command, used identically by a developer and by CI |
| **A migration-generation wrapper** (`scripts/generate-migration.mjs`) | `drizzle-kit` resolves its own `node_modules` with a path join that breaks when the repository path contains a space |
| **The invoice-send path delivers inline** rather than fully enqueueing | The email is written to the outbox before the attempt, so it is never lost, but the request does wait for the SMTP round trip. Recorded as remaining work rather than described as "asynchronous" |
| **No job-administration UI** | `JobQueue.listFailed/retry/stats` exist in the service; no route exposes them. Dead letters are queryable, not clickable. Documented in [OPERATIONS.md §2.3](OPERATIONS.md) |
| **No organization deletion** | The `organization.delete` permission and `organizations.deleted_at` exist, but no endpoint consumes them, so there is no confirmation, retention policy or audit path. Shipping a destructive endpoint without those would be worse than not shipping it |

## What "done" was allowed to mean

The specification's rule is that a polished interface is not a completed
product. The working definition used throughout:

> A feature is done when it is enforced on the server, persisted, covered by a
> test, reachable through a real screen, and honest about its state.

Under that rule the honest completions and honest gaps are enumerated in
[IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md).