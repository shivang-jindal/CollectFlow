# CollectFlow

Invoice and payment collection workflow for small businesses: create invoices,
send them, record what has been paid, follow up on overdue balances, and report
on receivables.

**What CollectFlow is not.** It is not a bank, a payment processor, an
accounting authority or a tax adviser. It never holds customer funds and never
stores card numbers or CVVs. Online payments are performed by a payment
provider or the customer's bank; **no payment-provider adapter ships with this
release** (see [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md)).

## Documentation

| Document | Contents |
| --- | --- |
| [docs/PRODUCT_SPEC.md](docs/PRODUCT_SPEC.md) | Business rules: money, totals, numbering, statuses, ledger, reminders, public links, email truthfulness |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Components, module map, data flow, tenancy, job queue, two rules learned from real defects |
| [docs/API.md](docs/API.md) | Full endpoint reference with permissions, fields, responses and error codes |
| [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md) | Email (SMTP) setup, sandbox-first workflow, the payment-provider boundary, disconnect/reconnect |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | Jobs, retries, health checks, logs, backups and restore, deployment order, rollback, incident runbook |
| [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) | Phase 0-7 plan as executed, with real file paths |
| [docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md) | Honest completion checklist, commands run, limitations, remaining work |
| [SECURITY.md](SECURITY.md) | Security assumptions, threat notes, how to report a vulnerability |

---

## 1. Prerequisites

| Requirement | Version | Notes |
| --- | --- | --- |
| Node.js | `>= 20.11` (`engines` in `package.json`) | Verified locally on Node `v24.20.0` |
| npm | 10 or newer (ships with Node 20+) | Workspace-aware |
| PostgreSQL | 14+ | **Optional.** Without `DATABASE_URL` the app runs on the embedded PGlite PostgreSQL build |
| SMTP account | — | **Optional.** Email is disabled until configured |

> **Windows PowerShell note.** On this machine PowerShell script execution is
> disabled, so the `npm.ps1` / `npx.ps1` shims fail. Use `npm.cmd` and
> `npx.cmd` in PowerShell. On macOS/Linux, `npm` and `npx` work normally. The
> repository's own helper scripts (`scripts/dev.mjs`, `scripts/verify.mjs`)
> already invoke `npm.cmd` internally.

Optional tools:

- `npx playwright install chromium` — only for the end-to-end tests.
- `psql` — only if you want to inspect a hosted PostgreSQL database directly.

---

## 2. Install

```powershell
# Windows PowerShell
cd "E:\Downloads\SaaS 12345\CollectFlow"
npm.cmd ci
npm.cmd run build:shared
```

```bash
# macOS / Linux
cd CollectFlow
npm ci
npm run build:shared
```

`npm ci` installs all three workspaces (`shared`, `server`, `client`).
`build:shared` compiles `@collectflow/shared`, which the server and client both
consume. Most later commands do this automatically, but doing it once up front
surfaces build problems early.

---

## 3. Environment configuration

Copy the example file and edit it:

```powershell
Copy-Item .env.example .env     # Windows PowerShell
```

```bash
cp .env.example .env           # macOS / Linux
```

`.env.example` is the authoritative list of variables. The most important ones:

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `NODE_ENV` | no | `development` | `development` / `test` / `production` |
| `PORT` | no | `4000` | API port |
| `API_URL` | no | `http://localhost:4000` | Public API URL, used in links and CORS |
| `APP_URL` | no | `http://localhost:5173` | Public web URL; used to build public invoice links |
| `APP_URLS` | no | – | Extra allowed CORS origins, comma separated |
| `DATABASE_URL` | production only | – | PostgreSQL connection string. **Empty selects embedded PGlite** |
| `PGLITE_DATA_DIR` | no | `.data/pgdata` | PGlite data directory, resolved relative to `server/` |
| `DATABASE_POOL_MAX` | no | `10` | node-postgres pool size |
| `EMAIL_PROVIDER` | no | `disabled` | `disabled` / `smtp` / `log` (see §8) |
| `SMTP_HOST` `SMTP_PORT` `SMTP_SECURE` `SMTP_USER` `SMTP_PASSWORD` | with `smtp` | – | SMTP connection |
| `FROM_EMAIL` | with `smtp` | – | Sender address |
| `ENCRYPTION_KEY` | to store credentials | – | 64 hex characters (32 bytes); AES-256-GCM key |
| `WORKER_ENABLED` | no | `true` | Worker switch read by the worker process |
| `WORKER_POLL_INTERVAL_MS` | no | `2000` | Queue poll interval |
| `WORKER_CONCURRENCY` | no | `3` | Jobs claimed per drain pass |
| `WORKER_IN_API` | no | unset | Set to `true` to run the worker inside the API process (single-process deployments only) |
| `SESSION_COOKIE_NAME` | no | `collectflow_session` | Session cookie name |
| `SESSION_TTL_HOURS` | no | `336` (14 days) | Session lifetime |
| `COOKIE_SECURE` | no | `true` when `NODE_ENV=production` | HTTPS-only cookie flag |
| `TRUST_PROXY` | no | `false` | Set `true` behind a reverse proxy |
| `LOG_LEVEL` | no | `info` | `fatal`…`silent` |
| `RATE_LIMIT_WINDOW_MS` | no | `60000` | Rate-limit window |
| `RATE_LIMIT_MAX` | no | `300` | Requests per window per IP for `/api/v1` |
| `AUTH_RATE_LIMIT_MAX` | no | `20` | Requests per window per IP for the webhook route |
| `SEED_EMAIL` / `SEED_PASSWORD` | no | `demo@collectflow.test` / `collectflow-demo-1234` | Demo seed credentials |

### The `.env` file is not read automatically

The API, worker and CLI read configuration from the **process environment**.
Nothing in this repository calls `dotenv`, so copying `.env.example` to `.env`
does nothing on its own. Pick one of the three approaches below.

**Option A — import `.env` into the current shell (works everywhere).**

```powershell
# Windows PowerShell, from the repository root
Get-Content .env | Where-Object { $_ -match '^[A-Za-z_][A-Za-z0-9_]*=' } | ForEach-Object {
  $name, $value = $_ -split '=', 2
  Set-Item -Path "Env:$name" -Value $value
}
```

```bash
# macOS / Linux, from the repository root
set -a; . ./.env; set +a
```

Re-run it in every new shell or terminal tab.

**Option B — pass `--env-file` to Node (Node >= 20.6).**

```powershell
node --env-file=.env server/dist/index.js        # production API
node --env-file=.env server/dist/worker.js       # production worker
npx.cmd tsx --env-file=../../.env src/index.ts   # one-off dev run from server/
```

**Option C — set the variables directly in your hosting platform's secret
store.** This is the only option that is appropriate in production.

Generate an encryption key:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## 4. Database

### 4.1 The embedded PGlite default

If `DATABASE_URL` is empty, `server/src/db/client.ts` starts
`@electric-sql/pglite`, an embedded, file-backed **PostgreSQL 16** build. It
speaks real PostgreSQL SQL, so the production migrations, constraints,
transactions and window functions behave identically. Data lives in
`server/.data/pgdata/` (controlled by `PGLITE_DATA_DIR`, resolved relative to
`server/`, which is the working directory npm uses for workspace scripts).

Use PGlite for local development, tests and CI. **Do not use it in production**
— there is one process writer, no network access, and no external backup story.

### 4.2 Switching to hosted PostgreSQL

Set one variable. No code change, no second schema, no second migration set.

```bash
# macOS / Linux
export DATABASE_URL='postgresql://USER:PASSWORD@HOST:5432/collectflow?sslmode=require'
```

```powershell
# Windows PowerShell
$env:DATABASE_URL = 'postgresql://USER:PASSWORD@HOST:5432/collectflow?sslmode=require'
```

Notes:

- `DATABASE_URL` selects `node-postgres` (`pg`) with a pool of
  `DATABASE_POOL_MAX`. `server/src/db/client.ts` enables TLS unless the host is
  localhost/127.0.0.1/[::1] or the URL says `sslmode=disable`.
- The connection string is never logged in full. `describe` prints only
  `postgres://host:port/database`.
- Create the database first (for example `createdb collectflow`), then run the
  migrations below.
- Any PostgreSQL provider works (Supabase, Neon, RDS, a container). Verify the
  provider's own free-tier and quota limits before relying on them; they change.

### 4.3 Migrations

```powershell
npm.cmd run db:migrate      # Windows PowerShell
npm run db:migrate          # macOS / Linux
```

Applies every pending SQL file from `server/drizzle/` and is safe to run
repeatedly. The migration folder currently contains one file,
`server/drizzle/0000_redundant_leech.sql`, with its journal in
`server/drizzle/meta/`.

`server/src/db/migrate-cli.ts` picks the same driver the API would use, so the
command exercises the real production path. The API and worker also run pending
migrations on start (`server/src/index.ts`, `server/src/worker.ts`), which means
a deployment is never blocked on a forgotten migration.

To create a new migration after editing `server/src/db/schema.ts`:

```powershell
npm.cmd run db:generate
```

`npm run db:generate` runs `scripts/generate-migration.mjs`, which invokes
`drizzle-kit generate` inside a space-free temporary directory. drizzle-kit
resolves its own `node_modules` with a path join that breaks when the repository
path contains a space (this repository lives under `E:\Downloads\SaaS 12345\`),
so the wrapper works around it. Review the generated SQL before committing it.

### 4.4 Development seed

```powershell
npm.cmd run db:seed
```

Creates one demo organization ("Demo Studio", USD, `America/New_York`) with two
customers, two sent invoices (one partially paid, one overdue) and three
recorded bank transfers. It refuses to run when `NODE_ENV=production`
(`server/src/db/seed.ts`). It is idempotent: if the demo email already exists it
prints a message and does nothing.

Printed credentials:

| | |
| --- | --- |
| Email | `demo@collectflow.test` |
| Password | `collectflow-demo-1234` |

Override with `SEED_EMAIL` / `SEED_PASSWORD`. **Change or remove this account
before exposing the application to anyone.**

A production account starts empty. There is no automatic seeding.

---

## 5. Tests

```powershell
# Unit + integration (Vitest). Each test file boots its own in-memory PGlite
# instance with the real migrations applied.
npm.cmd test

# Watch mode
npm.cmd run test:watch

# End-to-end (Playwright). Requires the seed and a running dev stack.
npx.cmd playwright install chromium
npm.cmd run db:migrate
npm.cmd run db:seed
npm.cmd run dev            # leave running in another terminal
npm.cmd run test:e2e
```

`vitest.config.ts` includes `server/tests/**/*.test.ts` and
`shared/src/**/*.test.ts`, with `fileParallelism: false` because each file
starts its own embedded PostgreSQL.

What the suites cover (`server/tests/`):

| File | Coverage |
| --- | --- |
| `money.test.ts` | Minor-unit parsing/formatting, currency exponents, half-away-from-zero rounding, proportional discount allocation, derived status |
| `domain.test.ts` | Concurrent invoice numbering, server-side totals, paid/partial, over-allocation rejection, currency mismatch, reversal recalculation, provider webhook replay dedupe, tenant isolation, reminder idempotency and opt-out |
| `api.test.ts` | Health endpoints, error envelope, server-side validation, login failure parity, HTTP-only cookie, cross-tenant 404, the customer→invoice→payment→PDF journey, void guard, public token fields and revocation, truthful integration status, webhook refusal, CSV escaping |
| `harness.ts` | Boots an in-memory PGlite database with production migrations |

Playwright (`tests/e2e/`) runs `journey.spec.ts` (desktop) and
`responsive.spec.ts` (Pixel 5 / 360 px) against `http://localhost:5173`.
Override with `E2E_BASE_URL`.

---

## 6. Running the application

### 6.1 Everything at once (development)

```powershell
npm.cmd run dev
```

`scripts/dev.mjs` starts three children with prefixed output and stops all of
them on Ctrl+C:

| Process | Output |
| --- | --- |
| `api` | `http://localhost:4000` |
| `worker` | database-backed job queue, no HTTP port |
| `web` | `http://localhost:5173` (Vite, proxies `/api` to the API origin) |

### 6.2 Each process separately

```powershell
npm.cmd run dev:server    # tsx watch server/src/index.ts   -> :4000
npm.cmd run dev:worker    # tsx watch server/src/worker.ts
npm.cmd run dev:client    # vite                            -> :5173
```

```bash
npm run dev:server
npm run dev:worker
npm run dev:client
```

The worker is optional for exploring the UI; reminders and scheduled emails
require it.

---

## 7. Production build

```powershell
npm.cmd run build          # shared -> server (tsc) -> client (vite)
npm.cmd start              # node server/dist/index.js
npm.cmd run worker:start -w @collectflow/server   # or: node server/dist/worker.js
```

Build outputs:

| Path | Contents |
| --- | --- |
| `shared/dist` | Compiled `@collectflow/shared` |
| `server/dist` | Compiled API, worker and migrations lookup |
| `client/dist` | Static assets for a CDN or static host |

The client build uses `tsc --noEmit && vite build`, so a type error fails the
build. Vite emits no source maps. **No server variable is bundled into the
client**: the browser only ever calls same-origin `/api/v1/*` paths and holds no
token outside the HTTP-only cookie.

### Deployment order

Migrate → API → worker → web. Rationale and rollback are in
[docs/OPERATIONS.md](docs/OPERATIONS.md).

```bash
npm ci
npm run build
npm run db:migrate          # 1. schema first; both old and new code tolerate it
# 2. deploy the API, verify /api/v1/health/ready
# 3. deploy the worker
# 4. deploy the client, verify APP_URL and CORS
```

Required production environment: `NODE_ENV=production`, `DATABASE_URL`,
`API_URL`, `APP_URL`, `ENCRYPTION_KEY`, `FROM_EMAIL`, and
`EMAIL_PROVIDER=smtp` with SMTP credentials if email should work. Put the client
on a static host behind HTTPS, and the API and worker on a Node 20+ host.
`COOKIE_SECURE` defaults to `true` in production; keep it that way.
Set `TRUST_PROXY=true` if a proxy terminates TLS in front of the API.

---

## 8. Email

Email is **disabled by default** and the UI says "Not connected" until a real
provider is configured. The development-only `log` transport captures messages
to `server/.data/outbox/` and delivers nothing; the API refuses to start with
`EMAIL_PROVIDER=log` when `NODE_ENV=production`. Full instructions are in
[docs/INTEGRATIONS.md](docs/INTEGRATIONS.md).

---

## 9. Smoke test

Run after every deployment.

```powershell
npm.cmd run db:seed                                   # only on a demo database
node scripts/smoke.mjs http://localhost:4000
```

```bash
npm run db:seed
node scripts/smoke.mjs https://api.your-domain.example
```

`scripts/smoke.mjs` checks `/api/v1/health/ready`, signs in with the demo
account, reads the dashboard, invoice list and receivables report, asserts the
integrations report a truthful status, and confirms an invalid id is rejected.
It prints `ok`/`FAIL` per check and exits non-zero on the first failure. It
requires the seeded demo account, so do not run it against a production
database.

---

## 10. Local quality gate

```powershell
npm.cmd run verify
```

Runs, in order: shared build, server type-check, client type-check, ESLint, unit
and integration tests, production build. This is what CI runs
(`.github/workflows/ci.yml`), followed by `npm run db:migrate` and
`npm run db:seed` against an empty embedded database.

---

## 11. Repository layout

```
CollectFlow/
├── client/                  React + Vite web app (client/src/**)
├── server/                  Express API, domain services, worker
│   ├── drizzle/             Real SQL migrations
│   └── src/
│       ├── db/              schema, client (postgres|pglite), seed, migrations
│       ├── http/routes/     Express routers
│       ├── integrations/    Email adapter boundary
│       ├── jobs/            Queue, worker, handlers
│       ├── pdf/             Invoice PDF renderer
│       ├── services/        Domain services
│       └── lib/             Crypto helpers, small utilities
├── shared/                  Zod schemas, money maths, invoice totals, dates, CSV
├── scripts/                 dev.mjs, verify.mjs, smoke.mjs, generate-migration.mjs
├── tests/e2e/               Playwright journeys
├── .env.example
└── .github/workflows/ci.yml
```

---

## 12. Known limitations

Stated up front rather than discovered later. The full list with severity is in
[docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md).

- **No payment-provider adapter ships.** The boundary, storage, encryption,
  verification action and webhook route exist and all report
  "Configuration required". Online payment is not available.
- **No SMTP delivery receipt.** `sent` means the provider accepted the message.
  CollectFlow never claims an email was delivered.
- **PGlite is for development and CI only.** Production needs `DATABASE_URL`.
- **No exchange rates.** Amounts are grouped per currency and never added
  across currencies.
- **No email-verification flow or account self-service deletion.** Password
  reset depends on a working email provider.
- **Login is not rate-limited separately.** Authentication endpoints share the
  global `/api/v1` limit.
- **No OpenAPI document is generated.** `docs/API.md` is the endpoint
  reference and is maintained by hand.