# CollectFlow — Operations

Running the deployed system: jobs, health, logs, backups, deployment, rollback,
monitoring and the incident runbook.

Everything here describes behaviour implemented in `server/src/**`. Where a
procedure has **not** been exercised in this repository's environment, it says
so.

---

## 1. Processes

| Process | Command (production) | Needs a port | Notes |
| --- | --- | --- | --- |
| API | `node server/dist/index.js` | `PORT` (4000) | Applies pending migrations on start |
| Worker | `node server/dist/worker.js` | none | Applies pending migrations on start |
| Web | static files from `client/dist` | 80/443 | Any CDN or static host |

The API can host the worker in-process with `WORKER_IN_API=true`. That is only
acceptable for a **single-instance** deployment: with two instances the embedded
worker and the separate worker would both drain the same queue. `FOR UPDATE SKIP
LOCKED` makes that *safe* (no job runs twice), but it wastes a connection slot
and doubles the memory of the API process. Recommended layout: one API
instance, one worker instance, `WORKER_IN_API` unset.

---

## 2. Background jobs

### 2.1 The model

| Property | Value | Source |
| --- | --- | --- |
| Queue | `background_jobs` table | `server/src/db/schema.ts` |
| Claim | `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED LIMIT 1)` inside one transaction | `server/src/jobs/queue.ts` `claimNext` |
| Concurrency per worker | `WORKER_CONCURRENCY` (default 3) claims per pass | `server/src/jobs/worker.ts` `drainOnce` |
| Idle poll | `WORKER_POLL_INTERVAL_MS` (default 2000 ms) | same |
| Lease | `locked_at` + `locked_by` | `background_jobs` |
| Lease recovery | every 60 s, `running` rows whose `locked_at` is older than 300 s return to `queued` | `reapStale` |
| Max attempts | 5 (`max_attempts`) | `JobQueue.enqueue` default |
| Success | `status='succeeded'`, `completed_at` set, lock cleared | `markSucceeded` |

### 2.2 Job types and what they do

| `job_type` | Enqueued by | Idempotency key | Effect |
| --- | --- | --- | --- |
| `reminders.schedule` | worker, every 15-minute bucket | `reminders.schedule:<orgId>:<bucket>` | Materialises due `reminder_logs` rows and queues their emails |
| `invoices.reconcile` | worker, every 15-minute bucket | `invoices.reconcile:<orgId>:<bucket>` | Marks queued reminders `skipped` for invoices that are already paid |
| `maintenance.cleanup` | worker, every 15-minute bucket | `maintenance.cleanup:<bucket>` | Deletes expired sessions and revoked sessions older than 30 days, and expired password-reset tokens |
| `email.deliver` | `reminders.schedule` | `email-deliver:<messageId>` | Hands one `email_messages` row to the configured adapter |

An unknown job type fails immediately with `retryable: false` and
`lastErrorCode = 'unknown_job_type'`.

**Recurring jobs are idempotent by bucket.** The key contains
`floor(now / 15 minutes)`, so a worker restart, a second worker or a redeploy
cannot enqueue the same bucket twice — enforced by the partial unique index
`background_jobs_idempotency_idx`.

### 2.3 Retry and backoff

`markFailed(jobId, { code, message }, { retryable })`:

```
exhausted   = attempts >= max_attempts        (5)
backoff     = min(5000 × 2^(attempts − 1), 15 minutes)
jitter      = random(0, min(backoff, 30 seconds))
nextRunAt   = now + backoff + jitter
```

| Attempt | Nominal wait |
| --- | --- |
| 1 | 5 s |
| 2 | 10 s |
| 3 | 20 s |
| 4 | 40 s |
| 5 | `failed` — dead letter |

If the error is **not** retryable (a permanent configuration problem, an unknown
job type, `email_not_configured`) the job goes straight to `failed` regardless of
remaining attempts. Nothing retries forever.

A dead letter is **visible**: `status='failed'` with `last_error_code` and
`last_error_message` (truncated to 500 characters) retained in the table.
`JobQueue.listFailed()`, `JobQueue.stats()` and `JobQueue.retry(jobId)` exist in
the service layer; **no HTTP route exposes them yet**, so today the query has to
be run against the database directly:

```sql
SELECT id, job_type, attempts, last_error_code, left(last_error_message, 200) AS message, completed_at
  FROM background_jobs
 WHERE status = 'failed'
 ORDER BY completed_at DESC
 LIMIT 50;
```

Manual retry of one job:

```sql
UPDATE background_jobs
   SET status = 'queued', attempts = 0, run_after = now(),
       last_error_code = NULL, last_error_message = NULL
 WHERE id = '<uuid>';
```

All handlers are idempotent, so a manual retry cannot double-send a reminder or
duplicate an email.

### 2.4 Running a job by hand

```sql
-- enqueue one (idempotency key makes a repeat a no-op)
INSERT INTO background_jobs (job_type, payload_json, status, run_after, idempotency_key)
VALUES ('reminders.schedule', '{"organizationId":"<org-uuid>"}'::jsonb, 'queued', now(),
        'manual:reminders.schedule:<org-uuid>:' || extract(epoch from now())::bigint)
RETURNING id;
```

The worker picks it up within `WORKER_POLL_INTERVAL_MS`.

### 2.5 Health of the queue

```sql
-- depth and age
SELECT status, count(*), min(run_after) AS oldest_run_after
  FROM background_jobs GROUP BY status;

-- currently leased
SELECT locked_by, locked_at, job_type
  FROM background_jobs
 WHERE status = 'running' AND locked_at < now() - interval '5 minutes';
```

An empty `queued` table with a running worker and a non-empty `succeeded` table
is healthy. A growing `queued` table, or a `running` row with an old
`locked_at`, means the worker is gone.

---

## 3. Health checks

| Endpoint | Use | Meaning |
| --- | --- | --- |
| `GET /api/v1/health/live` | Liveness probe | Process is up. Always `200` while the process can answer |
| `GET /api/v1/health/ready` | Readiness probe | `200` only when `select 1` succeeds against the database; `503` otherwise |
| `GET /api/v1/health/info` | Diagnostics | Service name, environment, worker config, email adapter name with `deliversMessages` and its setup hint, and the startup `warnings` array |

None of the three require authentication, and all three are **excluded from the
`/api/v1` rate limiter**, so an orchestrator probing every few seconds does not
consume the request budget.

`/health/ready` response:

```json
{
  "status": "ready",
  "checks": [
    { "name": "database", "ok": true },
    { "name": "email", "ok": true, "detail": "disabled: No email provider is configured. Email sending is disabled." }
  ],
  "warnings": ["ENCRYPTION_KEY is not set: integration credentials cannot be stored. …"],
  "environment": "production"
}
```

**Email never makes the service unready.** The email check always reports
`ok: true` with a `detail` string, because the product is fully usable with PDF
download and manual payments when email is down. Treat the email `detail` as an
alerting signal, not a gating check.

The `warnings` array surfaces, at request time, the conditions that matter at
deploy time:

| Warning | Meaning |
| --- | --- |
| `DATABASE_URL is not set: using the embedded PGlite PostgreSQL instance…` | **Production is running on the embedded database.** Fix immediately |
| `ENCRYPTION_KEY is not set: integration credentials cannot be stored…` | Integration credentials cannot be stored |
| `EMAIL_PROVIDER=log: messages are written to the log and the outbox only…` | Development transport in use |
| `COOKIE_SECURE should stay enabled in production.` | Session cookie will be sent over HTTP |

Suggested probe configuration: liveness every 15 s with a 5 s timeout;
readiness every 10 s with a 3 s timeout; restart the container after 3
consecutive readiness failures.

Note that `/health/ready` does **not** check the worker. Monitor the worker by
its own log stream and the queue query in §2.5.

---

## 4. Logs and request ids

### 4.1 Format

Pino, one JSON object per line, ISO-8601 timestamps, process name in `name`
(`api`, `worker`, `seed`, `test`).

```json
{"level":30,"time":"2026-10-18T10:16:32.912Z","name":"api","port":4123,"env":"development","msg":"CollectFlow API listening on 4123"}
{"level":30,"time":"2026-10-18T10:16:32.639Z","name":"api","driver":"pglite","database":"pglite (…\\server\\.data\\pgdata)","msg":"database connected"}
{"level":20,"time":"2026-10-18T10:17:03.257Z","name":"api","code":"VALIDATION_ERROR","requestId":"req_jeziug8lmvdo8cmu","path":"/api/v1/4fe5731d-…/invoices/not-a-uuid","msg":"request rejected"}
```

Levels: `fatal`(60) `error`(50) `warn`(40) `info`(30) `debug`(20) `trace`(10)
`silent`. In development the level is forced to `debug`; in production
`LOG_LEVEL` applies (default `info`). Set `LOG_LEVEL=silent` to suppress
everything.

### 4.2 Request ids

- Generated as `req_<base36>` per request, or taken from an incoming
  `X-Request-Id` header (truncated to 80 characters).
- Present in the error envelope (`error.requestId`), in rejected-request log
  lines, in unhandled-error log lines, and on `audit_events.request_id` for
  audited writes.
- It is the join key between a user's bug report and the server's logs. Ask for
  it, then search for it verbatim.

Successful requests are not logged at `info`; only rejections and errors are.
Successful request tracing therefore relies on the audit trail
(`GET /:organizationId/audit` includes `requestId`), not on access logs. If you
need full access logging, put a proxy in front and log there.

### 4.3 Redaction

Pino redacts `req.headers.authorization`, `req.headers.cookie`,
`headers.authorization`, `headers.cookie`, `*.password`, `*.passwordHash`,
`*.token`, `*.apiKey`, `*.secret`, `credentials.*`. Audit metadata is passed
through `redactObject` before storage. Database connection strings are redacted
to `postgres://host:port/db`. SMTP errors are stripped of `password|pass|secret|
token|api_key` assignments. See SECURITY.md §7 for the full list.

### 4.4 Log locations

In development the API writes `server/api.log` and `server/api.err.log` if you
redirect it. In production, capture stdout/stderr through your platform's log
shipper and rotate on a schedule. **Keep stdout clean**: the only structured
output is Pino JSON, plus a single line on startup failure.

---

## 5. Backups and restore

### 5.1 What must be backed up

Everything. The database is the only stateful component: no filesystem state, no
object storage, no third-party state. `server/.data/pgdata` is the embedded
database and is only relevant in development.

### 5.2 Managed PostgreSQL (production)

Most managed providers offer daily automated backups with point-in-time
recovery. **Treat the provider's retention window as your recovery point
objective** and verify it — retention and pricing change.

| | Recommended |
| --- | --- |
| Frequency | Daily automated snapshot **plus** point-in-time recovery |
| Retention | 7–30 days, matched to how long a lost day of invoicing would hurt |
| Cross-region copy | Yes, if the provider supports it |
| Encryption at rest | Provider default is acceptable |

Verify what the provider actually offers before relying on it.

### 5.3 Self-managed backups

```bash
# Custom-format dump — required for pg_restore
pg_dump --format=custom --no-owner --no-acl \
        --file=collectflow-$(date -u +%Y%m%dT%H%M%SZ).dump "$DATABASE_URL"

# Plain SQL, for inspection or a different tool
pg_dump --format=plain --no-owner --no-acl \
        --file=collectflow-$(date -u +%Y%m%dT%H%M%SZ).sql "$DATABASE_URL"

# Windows PowerShell
$stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
pg_dump --format=custom --no-owner --no-acl --file="collectflow-$stamp.dump" $env:DATABASE_URL
```

Recommended minimum: `pg_basebackup` (or the provider's equivalent) plus WAL
archiving for a full point-in-time recovery story. A nightly `pg_dump` alone
means up to 24 hours of data loss.

### 5.4 Restore procedure — run it before you need it

An untested backup is not a backup.

**Step 1 — create a scratch database.** Never restore over production first.

```bash
createdb collectflow_restore_test
```

**Step 2 — restore.**

```bash
pg_restore --dbname=collectflow_restore_test \
           --no-owner --no-acl --exit-on-error \
           collectflow-20261018T101500Z.dump
```

```powershell
pg_restore --dbname=collectflow_restore_test --no-owner --no-acl --exit-on-error "collectflow-$stamp.dump"
```

`--exit-on-error` is important: without it `pg_restore` reports errors and
carries on, producing a partial restore that looks fine until a query fails.

**Step 3 — verify the schema.**

```sql
SELECT count(*) FROM drizzle.__drizzle_migrations;
SELECT table_name FROM information_schema.tables
 WHERE table_schema = 'public' ORDER BY table_name;
```

Expect 23 business tables plus `drizzle.__drizzle_migrations`. If the migration
count is 0, the dump did not include the migration journal.

**Step 4 — verify the data.**

```sql
SELECT count(*) FROM organizations;
SELECT count(*) FROM invoices;
SELECT count(*) FROM payments;
SELECT status, count(*) FROM invoices GROUP BY status;
SELECT organization_id, count(*) FROM payment_allocations GROUP BY 1;
```

Cross-check the invoice status counts against what the dashboard showed before
the incident. `invoices.status` must be consistent with `payment_allocations`;
if a count is off, the dump is incomplete or the transaction that wrote it was
never committed — do not open the application against this database.

**Step 5 — verify the application against the restore.** Start the API with
`DATABASE_URL` pointed at the restored database on an unused port, then run the
smoke test (§8). If it passes, the restore is usable.

**Step 6 — cut over.** Stop the API and the worker, take a fresh dump of the
current production database, restore it over the target if necessary, repoint
`DATABASE_URL`, start the worker, then the API, then the web tier, and re-run the
smoke test.

**Step 7 — record the RTO.** Note how long steps 1–6 took. That is your real
recovery time, and it is the number that matters.

> **Honest status:** the restore procedure above is the standard PostgreSQL
> workflow and is what should be used. It has **not** been executed against a
> managed PostgreSQL instance from this repository — no production database
> exists here. The only database exercised in this environment is the embedded
> PGlite development copy. **Run steps 1–5 against your real backups before
> going live** and write down the elapsed time.

### 5.5 Embedded PGlite

For a local machine, copy the directory:

```powershell
Copy-Item -Recurse "server\.data\pgdata" "server\.data\pgdata-backup"
```

Stop the API and the worker first — PGlite is single-writer. This is a
development convenience, not a backup strategy.

### 5.6 Retention and deletion

No retention policy or purge job is implemented for business data. Invoices,
payments, allocations, adjustments, revisions, audit events, reminder logs,
email messages and webhook events are retained indefinitely, and are only removed
by deleting the organization's rows. Deleting them is a manual, irreversible
database operation with no application workflow behind it — there is no
organization-deletion endpoint in this release.

Deletion from third-party backups outside the application's control (managed
provider snapshots, host-level snapshots) cannot be guaranteed and is not
promised.

---

## 6. Deployment

### 6.1 Order: migrate → API → worker → web

```
1. npm ci && npm run build          # on the build host
2. npm run db:migrate               # schema first
3. deploy + restart the API         # verify /health/ready
4. deploy + restart the worker
5. deploy the web bundle            # verify APP_URL, CORS, HTTPS
```

Why this order:

- **Migrate first.** Both the old and the new code must tolerate the new schema.
  Additive migrations are safe; a destructive one needs the expand/contract
  pattern and a second release.
- **API before worker.** The worker must not pick up job types the running API
  cannot serve.
- **Worker before web.** Reminder and reconciliation jobs should be running
  before users start sending invoices.
- **Web last.** The new client must only reach an API that already supports it.
  Route-level backwards compatibility for one release is cheap insurance.

Both the API and the worker also run pending migrations on start
(`runMigrations` in `server/src/index.ts` and `server/src/worker.ts`), so step 2
can be skipped in a single-instance emergency. Run it explicitly anyway — you
want the migration to fail loudly on a controlled host, not inside a restart.

### 6.2 Build

```bash
npm ci
npm run build          # shared -> server (tsc) -> client (vite build)
npm run verify         # optional: full gate (build + type-check + lint + tests)
```

Artifacts: `shared/dist`, `server/dist`, `client/dist`.

### 6.3 Required production environment

```
NODE_ENV=production
PORT=4000
API_URL=https://api.example.com
APP_URL=https://app.example.com
DATABASE_URL=postgresql://…            # required in production
ENCRYPTION_KEY=<64 hex chars>
EMAIL_PROVIDER=smtp
SMTP_HOST=…  SMTP_PORT=587  SMTP_SECURE=false  SMTP_USER=…  SMTP_PASSWORD=…
FROM_EMAIL=billing@example.com
COOKIE_SECURE=true                     # default true when NODE_ENV=production
TRUST_PROXY=true                       # behind a reverse proxy
LOG_LEVEL=info
WORKER_ENABLED=true
```

`COOKIE_SECURE` and `DATABASE_URL` are the two that break the product quietly
if wrong. Verify the `warnings` array in `/health/ready` is empty after
deploying.

### 6.4 TLS and the custom domain

Terminate TLS at the platform or reverse proxy for both the API and the web
bundle. The session cookie's `Secure` flag depends on `COOKIE_SECURE`. Set
`APP_URL` to the final `https://` origin: it is what CORS allows and what
public invoice links and password-reset links are built from.

### 6.5 Rollback

| Situation | Action |
| --- | --- |
| Bad client build | Redeploy the previous `client/dist`. No server change. Safe and instant. |
| Bad API build, schema is backwards compatible | Redeploy the previous `server/dist` and restart the API and the worker. |
| Bad API build, schema is not backwards compatible | **Roll the migration forward with a fix**, not backward. Drizzle migrations are forward-only by design. Restore from backup only as a last resort, accepting the data loss since the last backup. |
| Bad worker build | Redeploy the previous worker. In-flight jobs are leased; a restart returns them to `queued` after the 300 s lease expires, or immediately if you stop the worker cleanly. |

Never roll the schema backward. There is no `drizzle-kit` "down" migration path,
and hand-written `DROP` statements on a live database destroy tenant data.

Safe order for a code rollback: web → worker → API, the reverse of deployment.

### 6.6 Draining before a restart

Both processes handle `SIGTERM` and `SIGINT`: the API closes the HTTP server
then the database pool, with a hard 10-second exit; the worker stops claiming and
closes the database. Give the platform at least 15 seconds of termination grace
so the graceful path completes rather than the forced exit.

---

## 7. Monitoring

### 7.1 What to alert on

| Signal | Query or source | Alert when |
| --- | --- | --- |
| **Readiness** | `GET /api/v1/health/ready` | Non-200 for > 2 minutes |
| **Database is embedded in production** | `warnings[]` in `/health/ready` contains `DATABASE_URL is not set` | Always — it is a configuration error, not a trend |
| **`ENCRYPTION_KEY` missing** | `warnings[]` | Always |
| **`EMAIL_PROVIDER=log`** | `warnings[]` | Always |
| **Dead-letter jobs growing** | `SELECT count(*) FROM background_jobs WHERE status='failed'` | > 0 sustained for 15 min, or any growth |
| **Queue backlog** | `SELECT count(*) FROM background_jobs WHERE status='queued' AND run_after <= now()` | > 100 for > 10 min |
| **Stuck leases** | `status='running' AND locked_at < now() - interval '5 minutes'` | > 0 for > 10 min |
| **Email failures** | `SELECT failure_code, count(*) FROM email_messages WHERE status='failed' AND created_at > now() - interval '1 hour' GROUP BY 1` | Any sustained failure, or `auth_failed` at all (credentials) |
| **Reminders never sent** | `SELECT count(*) FROM reminder_logs WHERE status='queued' AND scheduled_for < now() - interval '1 hour'` | > 0 (the worker is not draining) |
| **Webhook refusals** | `SELECT count(*) FROM webhook_events WHERE status='rejected'` | Any increase — somebody is posting to the payment webhook |
| **5xx rate** | Log lines with `"level":50` | > 1% of requests over 5 min |
| **Validation errors** | Log lines with `"code":"VALIDATION_ERROR"` | Sudden jump — often a bad deploy or a broken client |
| **Database connections** | Provider dashboard | Near `DATABASE_POOL_MAX` sustained |
| **Disk / storage** | Provider dashboard | Backups failing to complete |

### 7.2 Health queries

```sql
-- Everything that matters, one row each
SELECT
  (SELECT count(*) FROM organizations WHERE deleted_at IS NULL)                     AS orgs,
  (SELECT count(*) FROM invoices  WHERE status IN ('sent','partially_paid'))       AS open_invoices,
  (SELECT count(*) FROM invoices  WHERE status = 'void')                           AS void_invoices,
  (SELECT count(*) FROM background_jobs WHERE status='queued')                      AS queued_jobs,
  (SELECT count(*) FROM background_jobs WHERE status='failed')                      AS failed_jobs,
  (SELECT count(*) FROM background_jobs WHERE status='running')                     AS running_jobs,
  (SELECT count(*) FROM email_messages WHERE status='sent'
     AND created_at > now() - interval '24 hours')                                 AS emails_24h;

-- Dead letters, with their reasons
SELECT job_type, last_error_code, count(*), max(completed_at) AS latest
  FROM background_jobs
 WHERE status = 'failed'
 GROUP BY job_type, last_error_code
 ORDER BY latest DESC;
```

### 7.3 Business sanity checks

Worth running weekly, because they catch silent data problems that no error log
records:

```sql
-- A paid invoice with no allocations: impossible through the API.
SELECT id, invoice_number FROM invoices
 WHERE status = 'paid' AND id NOT IN (SELECT DISTINCT invoice_id FROM payment_allocations);

-- An invoice whose stored total does not reconcile.
SELECT id, invoice_number, subtotal_minor, discount_minor, tax_minor, total_minor
  FROM invoices
 WHERE subtotal_minor - discount_minor + tax_minor <> total_minor;

-- Duplicate invoice numbers inside one organization (the unique index makes this
-- impossible; a non-empty result means the index was dropped).
SELECT organization_id, invoice_number, count(*)
  FROM invoices GROUP BY 1, 2 HAVING count(*) > 1;

-- Rows whose organization_id does not exist (the foreign key makes this
-- impossible; a non-empty result means constraints were disabled).
SELECT 'payments' AS t, count(*) FROM payments p
  WHERE NOT EXISTS (SELECT 1 FROM organizations o WHERE o.id = p.organization_id)
UNION ALL
SELECT 'invoices', count(*) FROM invoices i
  WHERE NOT EXISTS (SELECT 1 FROM organizations o WHERE o.id = i.organization_id);
```

---

## 8. Smoke test

Run after every deployment, and before declaring an incident resolved.

```bash
node scripts/smoke.mjs https://api.example.com
```

It checks, and exits non-zero on the first failure:

1. `GET /health/ready` returns `200` with `status: "ready"`.
2. `POST /auth/login` succeeds with the demo account.
3. The session carries an organization.
4. `GET /:orgId/dashboard` returns `200`.
5. `dashboard.outstanding` is an **array** (grouped by currency, never a
   cross-currency total).
6. `GET /:orgId/invoices` returns an `items` array and the first row has a
   derived `displayStatus`.
7. `GET /:orgId/reports/receivables` returns buckets.
8. `GET /:orgId/integrations` reports `email_smtp: "not_configured"` when no
   provider is configured — the smoke test fails if an integration claims to be
   connected when it is not.
9. An invalid id is rejected with `400`.

It requires the seeded demo account. **Do not run it against production**
unless you have deliberately created and will delete that account.

Manual follow-up for a real deployment: create a customer, create and send an
invoice, download the PDF, record a manual payment, confirm the dashboard total
changes, and revoke the public link.

---

## 9. Incident runbook

### 9.1 "Email is not being sent"

| Step | Check | Action |
| --- | --- | --- |
| 1 | `GET /api/v1/health/info` | `email.provider` should be `smtp`. If `disabled`, set `EMAIL_PROVIDER=smtp` and the `SMTP_*` variables and restart the API **and** the worker |
| 2 | `GET /api/v1/health/info` → `email.setupHint` | Lists the exact variables required |
| 3 | `POST /:orgId/integrations/email_smtp/test` | `ok: false` with a detail ⇒ the connection is broken. `auth_failed` ⇒ wrong credentials. `temporary`/`ECONNECTION` ⇒ host/port/firewall |
| 4 | `POST /:orgId/integrations/email_smtp/test-message` | The only end-to-end proof |
| 5 | `GET /:orgId/reminders/outbox` | `status` and `failureCode` per message; the `note` explains what `sent` means |
| 6 | `SELECT status, failure_code, count(*) FROM email_messages WHERE created_at > now() - interval '1 hour' GROUP BY 1, 2;` | Patterns below |
| 7 | `SELECT count(*) FROM reminder_logs WHERE status='queued' AND scheduled_for < now() - interval '1 hour';` | > 0 ⇒ the **worker** is not draining, not an email problem |
| 8 | `SELECT count(*) FROM background_jobs WHERE job_type='email.deliver' AND status='failed';` | Dead letters; inspect `last_error_code` |

Failure patterns:

| `failure_code` | Meaning | Action |
| --- | --- | --- |
| `not_configured` | No adapter | Set `EMAIL_PROVIDER=smtp`, restart |
| `auth_failed` | Credentials rejected | Re-check `SMTP_USER`/`SMTP_PASSWORD` |
| `temporary` | Timeout / DNS / refused | Check host, port, `SMTP_SECURE`, firewall |
| `permanent_recipient` | The address does not exist | Fix the customer's email address; not retried |
| `provider_error` | Anything else | Read `safeFailureMessage`; often a rejected `FROM_EMAIL` or a rate limit |

Also check: is the customer's email set, have they opted out, is the invoice paid
or void, are reminders paused (`remindersPaused` defaults to `true`), is the
target date within the 60-day horizon and the 3-day grace window?

### 9.2 "Reminders are not being scheduled"

| Check | Expected |
| --- | --- |
| Is the worker running? | Worker log shows `worker started` |
| `remindersPaused` | Must be `false` — it defaults to **`true`** |
| Rule `enabled` | All four default rules are **disabled** until turned on |
| `reminder_rules.offset_days` / `direction` | A negative `offsetDays` for `before` |
| Customer `reminder_opt_out` | `false` |
| Customer email present | Non-null |
| Invoice status | `sent` or `partially_paid`, with a balance > 0 |
| Invoice `due_date` | Non-null — **no due date, no reminders** |
| Target window | Within 60 days ahead and not more than 3 days behind |
| `reminder_logs` rows | One per `(org, invoice, rule, targetDate)`; a duplicate is impossible |

```sql
SELECT r.id, r.name, r.offset_days, r.direction, r.enabled, s.reminders_pused
  FROM reminder_rules r
  JOIN organization_settings s ON s.organization_id = r.organization_id
 WHERE r.organization_id = '<org-uuid>';

SELECT invoice_id, rule_id, target_date, status, attempt_count, safe_failure_message
  FROM reminder_logs
 WHERE organization_id = '<org-uuid>'
 ORDER BY created_at DESC LIMIT 25;
```

Enqueue one manually (§2.4) and watch the worker log to see which check fails.

### 9.3 "The dashboard total does not match what I expect"

1. Confirm the currency. Every monetary field is an **array grouped by
   currency**. `outstanding[0].amountMinor` is the figure, and there is no
   cross-currency total anywhere.
2. Confirm void invoices are excluded. They report a balance of `0` and are
   excluded from aging and collections. `excluded.voidInvoices` in the
   receivables report gives the count.
3. Confirm "collected this month" means `payments.status = 'recorded'` with
   `paid_at` inside the current calendar month in the **organization timezone**.
   A reversed, refunded or charged-back payment drops out of it.
4. If a single invoice's `paid` figure looks wrong after a partial refund, read
   the effective-allocation rule in
   [PRODUCT_SPEC.md §5.3](PRODUCT_SPEC.md). Each allocation is scaled by the
   payment's retained fraction, so the numbers are correct but may differ from a
   naive "subtract the refund" expectation.
5. Run the sanity queries in §7.3. A non-empty result means data corruption, not
   a display bug.

### 9.4 "The API returns 500 / `/health/ready` is 503"

| Step | Check |
| --- | --- |
| 1 | API log: the `"level":50` line carries the full stack and the `requestId`. Quote it. |
| 2 | `POSTGRES` connectivity from the API host: is the provider reachable? Did it rotate credentials or hit a connection cap? |
| 3 | Connection exhaustion: is `DATABASE_POOL_MAX` × instances below the provider's limit? Look for `timeout exceeded when trying to connect` |
| 4 | Did the database run out of disk, or is a migration half-applied? |
| 5 | Did a deploy change the schema? Compare `drizzle.__drizzle_migrations` with the running build |
| 6 | Rate limiting is not the cause — that returns `429`, not `500` |

Restart the API. With `database.close()` on shutdown and `runMigrations` on
start, a restart is safe: pending migrations are applied, in-flight jobs are not
lost (the worker holds the lease and `reapStale` returns it after 300 s).

### 9.5 "Database is on PGlite in production"

1. This is a misconfiguration, not an incident to debug. Create a managed
   PostgreSQL database.
2. Set `DATABASE_URL` in the deployment environment.
3. `npm run db:migrate` against the new database.
4. Restart the API, then the worker.
5. `GET /api/v1/health/ready` — the `DATABASE_URL is not set` warning must be
   gone.
6. If data matters, migrate it with `pg_dump` from the PGlite directory and
   `pg_restore` into the managed database, then re-run the sanity queries in
   §7.3 before opening the application.

### 9.6 "The public invoice link returns 404"

| Cause | Check |
| --- | --- |
| Never issued | The link is created on the first send. `GET /:orgId/invoices/:id` → `invoice.publicLinkActive` |
| Revoked | `public_token_revoked_at` is set — explicitly, or automatically by voiding the invoice |
| Malformed | The token must match `^[A-Za-z0-9_-]{32,64}$`; anything else is a `404` with no database lookup |
| Wrong token | `public_token_hash` is a SHA-256 of the token; only the *first* send returns the plaintext, so keep the link |
| Another tenant | The lookup is by hash only, so cross-tenant tokens cannot be forged — a wrong token simply does not match |

```sql
SELECT invoice_number, public_token_revoked_at, public_link_created_at, sent_at
  FROM invoices WHERE public_token_hash IS NOT NULL;
```

The token cannot be recovered — only `SHA-256` is stored. Send the invoice again
with link rotation to issue a new one.

### 9.7 "Login is failing for everyone"

1. Is the API up? `GET /api/v1/health/live`.
2. Is the database reachable? `GET /api/v1/health/ready`.
3. Are cookies reaching the browser? Check that the client is served over HTTPS
   and that `APP_URL` matches the browser origin — CORS is an explicit
   allow-list.
4. Is `COOKIE_SECURE=true` while the site is still on plain HTTP in a staging
   environment? The browser will silently drop the cookie.
5. Is `TRUST_PROXY` set when a proxy terminates TLS? It affects client IPs and
   rate limiting.
6. Check for `401` bursts in the logs with a `requestId`.
7. Nothing above? Check whether a rate limiter is engaging. `/api/v1` allows
   `RATE_LIMIT_MAX` (300) per minute per IP; **login is not separately
   rate-limited** (SECURITY.md §6).

### 9.8 Cross-tenant data leakage — suspected

Treat as a security incident, not a bug.

1. **Preserve evidence.** Snapshot the database before any cleanup, and keep the
   API and worker logs.
2. **Contain.** Rotate the session cookie (`SESSION_COOKIE_NAME`) and force
   revocation by updating `sessions` for the affected users; revoke
   `ENCRYPTION_KEY` next.
3. **Scope it.** Confirm every affected query filters on `organization_id`.
   `requireOrganization` is the single gate; a route that bypasses it is the
   defect to look for. Cross-tenant access returns `404`, never `403`, by
   design — a `403` would indicate a different bug.
4. **Reproduce.** `server/tests/api.test.ts` and `server/tests/domain.test.ts`
   already assert cross-tenant denial; extend them with the discovered path.
5. **Notify** through the private channel described in SECURITY.md.
6. Do not discuss the incident in a public issue.

### 9.9 Escalation

| Severity | Example | First action |
| --- | --- | --- |
| **Sev 1** | Cross-tenant leakage; database unavailable; money recorded incorrectly | Contain first, then diagnose. Preserve logs and a DB snapshot |
| **Sev 2** | API returning 5xx; worker not draining; no email reaching customers | Diagnose, then decide between fixing forward and rolling back |
| **Sev 3** | One organization's reminders failing; a stale integration status | Diagnose during working hours; no data risk |
| **Sev 4** | Cosmetic; confusing error text | Queue it |

For Sev 1 and any suspected vulnerability, follow the private reporting channel
in SECURITY.md rather than a public issue.