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
SESSION_SECRET="random-string"
STRIPE_SECRET_KEY="sk_..."
EMAIL_PROVIDER="smtp|disabled|log"
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
**Auth**: Argon2id · opaque 256-bit tokens · HTTP-only cookies  
**Database**: Drizzle ORM · single schema/migrations for PGlite + PostgreSQL  
**Jobs**: DB-backed queue (`FOR UPDATE SKIP LOCKED`) · separate worker

---

## Configuration

All settings via environment variables (see `.env.example`):

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | No | PostgreSQL URL (omit for PGlite) |
| `ENCRYPTION_KEY` | Yes | 64-char hex (32 bytes) |
| `SESSION_SECRET` | Yes | Random string |
| `STRIPE_SECRET_KEY` | No | Stripe secret key |
| `EMAIL_PROVIDER` | Yes | `smtp` \| `disabled` \| `log` |

---

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start dev servers (client + server) |
| `npm run build` | Production build |
| `npm run verify` | Typecheck + Lint + Test + Build |
| `npm test` | Unit/integration tests |
| `npm run db:generate` | Generate Drizzle migrations |
| `npm run db:migrate` | Run migrations |

---

## Testing

```bash
npm test              # All tests (51 passing)
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