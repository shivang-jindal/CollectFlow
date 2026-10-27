# CollectFlow

> **Invoice & Payment Collection Workflow for Small Businesses**

[![CI](https://github.com/shivang-jindal/CollectFlow/actions/workflows/ci.yml/badge.svg)](https://github.com/shivang-jindal/CollectFlow/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React-18-61dafb)](https://react.dev/)
[![Express](https://img.shields.io/badge/Express-4-lightgrey)](https://expressjs.com/)
[![Drizzle ORM](https://img.shields.io/badge/Drizzle-ORM-brightgreen)](https://orm.drizzle.team/)

---

## Features

- **Invoicing**: Create, send, track invoices with PDF generation
- **Payments**: Stripe integration + manual recording, webhook handling
- **Customers**: CRM with portals, statements, payment history
- **Automation**: Recurring invoices, overdue reminders, late fees
- **Multi-tenant**: Organizations, roles (Owner/Admin/Member/Viewer), audit logs
- **CSV Import**: Bulk customer/invoice imports with validation
- **Configurable**: Payment providers, email templates, currencies, tax rules

---

## Quick Start

```bash
# Prerequisites: Node 20+, npm 10+
git clone https://github.com/shivang-jindal/CollectFlow.git
cd CollectFlow
npm install
npm run dev
```

Configure `.env` (copy `.env.example`):
```env
DATABASE_URL="postgresql://..."  # or omit for PGlite (embedded)
ENCRYPTION_KEY="64-char-hex-key"
EMAIL_PROVIDER=disabled  # smtp | disabled | log
FIREBASE_PROJECT_ID=your-project  # enables Google sign-in (see below)
```

---

## Architecture

```
CollectFlow/
├── client/          # React 18 + Vite 6 + Tailwind v4
├── server/          # Express 4 + Drizzle ORM + PGlite
├── shared/          # Shared types, Zod schemas, constants
└── scripts/         # Dev, migration, verification
```

**Stack**: React 18 · Vite 6 · TypeScript · Tailwind v4 · React Router · TanStack Query  
**Backend**: Express 4 · Zod · Drizzle ORM · PGlite (embedded PostgreSQL)  
**Auth**: Google sign-in · server-verified Firebase ID tokens · HTTP-only session cookies  
**Database**: Drizzle ORM · single schema/migrations for PGlite + PostgreSQL  
**Jobs**: DB-backed queue (`FOR UPDATE SKIP LOCKED`) · separate worker

---

## Configuration

All settings via environment variables (see `.env.example`):

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | No | PostgreSQL URL (omit for embedded PGlite) |
| `ENCRYPTION_KEY` | For integrations | 64-char hex (32 bytes) used to encrypt stored credentials |
| `EMAIL_PROVIDER` | No | `smtp` \| `disabled` \| `log` (default `disabled`) |
| `FIREBASE_PROJECT_ID` | For Google sign-in | Firebase project id used to verify Google ID tokens |
| `VITE_FIREBASE_*` | For Google sign-in | Public Firebase web config read by the browser |

### Google sign-in

Google sign-in uses Firebase Authentication in the browser and verifies the
resulting ID token on the server against Google's published keys. No service
account or client secret is stored.

1. In the Firebase console, create a project and enable **Authentication -> Sign-in method -> Google**.
2. Add a web app, then put its public configuration in the repository `.env` (one root file, read by both the client and the server):

   ```bash
   VITE_FIREBASE_API_KEY=...
   VITE_FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com
   VITE_FIREBASE_PROJECT_ID=your-project
   VITE_FIREBASE_APP_ID=...
   FIREBASE_PROJECT_ID=your-project
   ```

3. Add `http://localhost:5173` and your production origin to **Authentication -> Settings -> Authorized domains**.

Vite reads these values at build time: restart the dev server or rebuild the
client after changing them.

**Google is the only sign-in method in the web app.** There is no registration
form, password form, "forgot password" page or reset link. An account is created
the first time someone signs in with Google and is matched by the verified email
address, so signing in again always reaches the same account.

With no Firebase values the button is disabled with a clear note and the API
refuses Google sign-in. The app does not pretend to offer another way in.

The password endpoints (`/auth/register`, `/auth/login`, `/auth/password/*`) are
kept for local seeding, the smoke script and the automated tests. The server
returns `404 NOT_FOUND` for them when `NODE_ENV=production`, so a deployed
instance has exactly one way in. Seed and run the demo against a development
server (`npm run db:seed && npm run dev`).

---

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start dev servers (client + server) |
| `npm run build` | Production build |
| `npm run verify` | Typecheck + Lint + Test + Build |
| `npm test` | Unit/integration tests (66 passing) |
| `npm run db:generate` | Generate Drizzle migrations |
| `npm run db:migrate` | Run migrations |

---

## Testing

```bash
npm test              # All tests (66 passing)
npm run test:watch    # Watch mode
npm run test:e2e      # Playwright E2E
```

---

## Deployment

```bash
npm run build
# Deploy server/ + client/dist/ to your platform
```

Requires: Node 20+, PostgreSQL (or PGlite for embedded), Redis optional for sessions.

---

## License

MIT License - see [LICENSE](LICENSE)

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) • [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) • [SECURITY.md](SECURITY.md)