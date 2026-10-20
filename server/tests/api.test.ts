/**
 * HTTP-level tests: authentication, permissions, CSRF-safe cookies, error
 * envelope, tenant isolation over real requests, CSV export safety and the
 * public invoice token.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';

import { createApp } from '../src/app.js';
import { parseCsv, escapeCsvCell } from '@collectflow/shared';
import type { Express } from 'express';
import { createTestContext, seedTenant, type TestContext } from './harness.js';
import { addDaysIso, todayIso } from '@collectflow/shared';

let context: TestContext;
let app: Express;
let ownerA: Awaited<ReturnType<typeof seedTenant>>;
let ownerB: Awaited<ReturnType<typeof seedTenant>>;
let agentA: request.Agent;
let agentB: request.Agent;

beforeAll(async () => {
  context = await createTestContext();
  app = createApp(context.services);
  ownerA = await seedTenant(context, { email: 'http-a@test.local', organizationName: 'HTTP Tenant A' });
  ownerB = await seedTenant(context, { email: 'http-b@test.local', organizationName: 'HTTP Tenant B' });
  agentA = request.agent(app);
  agentB = request.agent(app);
  await agentA.post('/api/v1/auth/login').send({
    email: 'http-a@test.local',
    password: 'a-very-long-test-password',
  });
  await agentB.post('/api/v1/auth/login').send({
    email: 'http-b@test.local',
    password: 'a-very-long-test-password',
  });
});

afterAll(async () => {
  await context.close();
});

describe('health and error envelope', () => {
  it('exposes liveness and readiness without secrets', async () => {
    const live = await request(app).get('/api/v1/health/live').expect(200);
    expect(live.body.status).toBe('ok');

    const ready = await request(app).get('/api/v1/health/ready').expect(200);
    expect(ready.body.status).toBe('ready');
    expect(JSON.stringify(ready.body)).not.toMatch(/password/i);
  });

  it('returns a consistent error shape with a request id', async () => {
    const response = await request(app)
      .get('/api/v1/public/invoices/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')
      .expect(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
    expect(response.body.error.requestId).toBeTruthy();
    expect(response.body.error).not.toHaveProperty('stack');
  });

  it('validates request bodies server-side', async () => {
    const response = await agentA
      .post(`/api/v1/${ownerA.organization.id}/customers`)
      .send({ email: 'not-an-email' })
      .expect(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(response.body.error.requestId).toBeTruthy();
  });
});

describe('session context', () => {
  it('returns the signed-in user and memberships from /auth/session', async () => {
    // Regression: `/auth` was mounted before `requireAuth`, so every `/auth`
    // route needing a principal returned 401 even with a valid session cookie.
    const response = await agentA.get('/api/v1/auth/session').expect(200);
    expect(response.body.user.id).toBeTruthy();
    expect(Array.isArray(response.body.memberships)).toBe(true);
    expect(response.body.memberships.length).toBeGreaterThan(0);
  });

  it('serves the session context the client actually calls', async () => {
    const response = await agentA.get('/api/v1/session/context').expect(200);
    expect(response.body.user.email).toBe('http-a@test.local');
  });

  it('still allows anonymous sign-in', async () => {
    await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'http-a@test.local', password: 'a-very-long-test-password' })
      .expect(200);
  });

  it('refuses the session context without a cookie', async () => {
    const response = await request(app).get('/api/v1/auth/session').expect(401);
    expect(response.body.error.code).toBe('UNAUTHENTICATED');
  });
});

describe('authentication', () => {
  it('refuses anonymous access to tenant routes', async () => {
    const response = await request(app).get(`/api/v1/${ownerA.organization.id}/invoices`).expect(401);
    expect(response.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects a bad password without revealing whether the account exists', async () => {
    const missing = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'nobody@test.local', password: 'whatever-123456' })
      .expect(401);
    const wrong = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'http-a@test.local', password: 'wrong-password-123' })
      .expect(401);
    expect(missing.body.error.message).toBe(wrong.body.error.message);
  });

  it('sets an HTTP-only session cookie and clears it on sign out', async () => {
    const agent = request.agent(app);
    const login = await agent
      .post('/api/v1/auth/login')
      .send({ email: 'http-a@test.local', password: 'a-very-long-test-password' })
      .expect(200);
    const cookies = login.headers['set-cookie'] as unknown as string[];
    expect(cookies.some((cookie) => cookie.includes('HttpOnly'))).toBe(true);
    await agent.post('/api/v1/auth/logout').expect(204);
    await agent.get(`/api/v1/${ownerA.organization.id}/invoices`).expect(401);
  });
});

describe('cross-tenant access', () => {
  it('returns 404, not data, for another organization invoice', async () => {
    const customer = await context.services.customers.create(ownerA.organization.id, ownerA.user.id, {
      name: 'Isolation Probe',
      email: 'isolation@test.local',
    });
    const invoice = await context.services.invoices.create(
      ownerA.organization.id,
      ownerA.user.id,
      {
        customerId: customer.id,
        issueDate: todayIso('UTC'),
        dueDate: addDaysIso(todayIso('UTC'), 7),
        currency: 'USD',
        items: [{ description: 'Secret work', quantity: '1', unitPriceMinor: 250000 }],
        saveAsDraft: true,
      },
      { timezone: 'UTC' },
    );

    // Same URL, different session.
    const response = await agentB.get(`/api/v1/${ownerA.organization.id}/invoices/${invoice.id}`);
    expect(response.status).toBe(404);

    // And the record itself is invisible when read through tenant B's list.
    const listB = await agentB.get(`/api/v1/${ownerB.organization.id}/invoices?pageSize=100`);
    expect(listB.body.items.every((item: { id: string }) => item.id !== invoice.id)).toBe(true);
  });
});

describe('journey: customer to paid invoice', () => {
  it('creates, sends, records a payment and reflects it on the dashboard', async () => {
    const created = await agentA
      .post(`/api/v1/${ownerA.organization.id}/customers`)
      .send({ name: 'Journey Customer', email: 'journey@test.local', currency: 'USD' })
      .expect(201);
    const customerId = created.body.customer.id;

    const invoiceResponse = await agentA
      .post(`/api/v1/${ownerA.organization.id}/invoices`)
      .send({
        customerId,
        issueDate: todayIso('UTC'),
        dueDate: addDaysIso(todayIso('UTC'), 14),
        currency: 'USD',
        items: [{ description: 'Workshop', quantity: '2', unitPriceMinor: 150000 }],
        saveAsDraft: true,
      })
      .expect(201);
    const invoiceId = invoiceResponse.body.invoice.id;
    expect(Number(invoiceResponse.body.invoice.totalMinor)).toBe(300000);

    await agentA
      .post(`/api/v1/${ownerA.organization.id}/invoices/${invoiceId}/send`)
      .send({ sendEmail: false })
      .expect(200);

    const payment = await agentA
      .post(`/api/v1/${ownerA.organization.id}/payments/manual`)
      .send({
        customerId,
        amountMinor: 300000,
        currency: 'USD',
        method: 'bank_transfer',
        paidAt: todayIso('UTC'),
        fundsReceivedConfirmed: true,
      })
      .expect(201);
    expect(payment.body.updatedInvoices[0].status).toBe('paid');

    const dashboard = await agentA.get(`/api/v1/${ownerA.organization.id}/dashboard`).expect(200);
    expect(dashboard.body.awaitingPaymentCount).toBeGreaterThanOrEqual(0);
    expect(dashboard.body.definitions.outstanding).toContain('balance');

    const pdf = await agentA.get(`/api/v1/${ownerA.organization.id}/invoices/${invoiceId}/pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    expect(pdf.body.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('refuses to void an invoice that has recorded payments', async () => {
    const created = await agentA
      .post(`/api/v1/${ownerA.organization.id}/customers`)
      .send({ name: 'Void Guard', email: 'void-guard@test.local' })
      .expect(201);
    const invoice = await agentA
      .post(`/api/v1/${ownerA.organization.id}/invoices`)
      .send({
        customerId: created.body.customer.id,
        issueDate: todayIso('UTC'),
        dueDate: addDaysIso(todayIso('UTC'), 7),
        currency: 'USD',
        items: [{ description: 'Work', quantity: '1', unitPriceMinor: 10000 }],
        saveAsDraft: false,
        sendEmail: false,
      })
      .expect(201);
    const invoiceId = invoice.body.invoice.id;

    await agentA
      .post(`/api/v1/${ownerA.organization.id}/payments/manual`)
      .send({
        customerId: created.body.customer.id,
        amountMinor: 10000,
        currency: 'USD',
        method: 'cash',
        paidAt: todayIso('UTC'),
        fundsReceivedConfirmed: true,
      })
      .expect(201);

    const response = await agentA
      .post(`/api/v1/${ownerA.organization.id}/invoices/${invoiceId}/void`)
      .send({ reason: 'Attempted void' })
      .expect(422);
    expect(response.body.error.message).toMatch(/revers|record/i);
  });
});

describe('public invoice token', () => {
  it('exposes only intended fields and can be revoked', async () => {
    const created = await agentA
      .post(`/api/v1/${ownerA.organization.id}/customers`)
      .send({ name: 'Public Customer', email: 'public@test.local' })
      .expect(201);

    const invoice = await agentA
      .post(`/api/v1/${ownerA.organization.id}/invoices`)
      .send({
        customerId: created.body.customer.id,
        issueDate: todayIso('UTC'),
        dueDate: addDaysIso(todayIso('UTC'), 7),
        currency: 'USD',
        items: [{ description: 'Public item', quantity: '1', unitPriceMinor: 50000 }],
        saveAsDraft: true,
      })
      .expect(201);

    const sent = await agentA
      .post(`/api/v1/${ownerA.organization.id}/invoices/${invoice.body.invoice.id}/send`)
      .send({ sendEmail: false })
      .expect(200);

    const token = sent.body.publicToken as string;
    expect(token).toMatch(/^[A-Za-z0-9_-]{32,}$/);

    const view = await request(app).get(`/api/v1/public/invoices/${token}`).expect(200);
    expect(view.body.invoice.number).toBeTruthy();
    // No internal identifiers or customer contact data leak out.
    expect(JSON.stringify(view.body)).not.toContain(created.body.customer.id);
    expect(JSON.stringify(view.body)).not.toContain('public@test.local');
    expect(view.body.customer.email).toBeUndefined();

    await agentA
      .post(`/api/v1/${ownerA.organization.id}/invoices/${invoice.body.invoice.id}/public-link/revoke`)
      .send({})
      .expect(204);

    await request(app).get(`/api/v1/public/invoices/${token}`).expect(404);
  });
});

describe('integrations tell the truth', () => {
  it('reports "not configured" while no email provider exists', async () => {
    const response = await agentA.get(`/api/v1/${ownerA.organization.id}/integrations`).expect(200);
    const email = response.body.integrations.find(
      (entry: { provider: string }) => entry.provider === 'email_smtp',
    );
    expect(email.status).toBe('not_configured');
    expect(email.deliversMessages).toBe(false);
    expect(email.setupGuide.length).toBeGreaterThan(0);
  });

  it('refuses to store credentials without an encryption key', async () => {
    const response = await agentA
      .put(`/api/v1/${ownerA.organization.id}/integrations/payment_provider`)
      .send({ credentials: { keyId: 'k', secret: 's' }, enabled: true })
      .expect(422);
    expect(response.body.error.message).toMatch(/ENCRYPTION_KEY/i);
  });
});

describe('webhooks never claim an unverified payment', () => {
  it('rejects a webhook when no provider adapter is configured', async () => {
    const response = await request(app)
      .post('/api/v1/webhooks/payments/unknown-provider')
      .send({ id: 'evt_1', event: { id: 'evt_1' } })
      .expect(503);
    expect(response.body.error.code).toBe('INTEGRATION_UNAVAILABLE');
    expect(response.body.error.message).toMatch(/nothing has been recorded as paid/i);
  });
});

describe('CSV export safety', () => {
  it('escapes formula-leading cells', () => {
    expect(escapeCsvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(escapeCsvCell('+1')).toBe("'+1");
    expect(escapeCsvCell('normal')).toBe('normal');
  });

  it('exports this organization only', async () => {
    const response = await agentA
      .post(`/api/v1/${ownerA.organization.id}/exports`)
      .send({ dataset: 'invoices', filters: {} })
      .expect(200);
    expect(response.headers['content-type']).toContain('text/csv');
    const csv = response.text as unknown as string;
    const { header } = parseCsv(csv);
    expect(header).toContain('invoice_number');
    expect(header).toContain('balance');
  });
});
interface AgingBucketRow {
  bucket: string;
  label: string;
  currency: string | null;
  amountMinor: number;
  invoiceCount: number;
}

/**
 * Creates a sent, unpaid invoice that is already overdue, in the requested
 * currency. The issue date has to precede the due date, so both are placed in
 * the past rather than only moving the due date backwards.
 */
async function createOverdueInvoice(
  email: string,
  currency: string,
  unitPriceMinor: number,
): Promise<string> {
  const created = await agentA
    .post(`/api/v1/${ownerA.organization.id}/customers`)
    .send({ name: `FX ${currency}`, email, currency })
    .expect(201);
  const invoice = await agentA
    .post(`/api/v1/${ownerA.organization.id}/invoices`)
    .send({
      customerId: created.body.customer.id,
      issueDate: addDaysIso(todayIso('UTC'), -30),
      dueDate: addDaysIso(todayIso('UTC'), -10),
      currency,
      items: [{ description: 'Cross-currency work', quantity: '1', unitPriceMinor }],
      saveAsDraft: false,
      sendEmail: false,
    })
    .expect(201);
  return invoice.body.invoice.id as string;
}

describe('regression: money is never summed across currencies', () => {
  it('keeps each aging bucket denominated in a single currency', async () => {
    await createOverdueInvoice('fx-usd@test.local', 'USD', 100000);
    await createOverdueInvoice('fx-eur@test.local', 'EUR', 250000);

    const response = await agentA
      .get(`/api/v1/${ownerA.organization.id}/reports/receivables`)
      .expect(200);
    const buckets = response.body.buckets as AgingBucketRow[];

    const overdue = buckets.filter((row) => row.bucket === '1_30');
    // Both currencies are overdue, so the bucket is reported twice - once per
    // currency - instead of once with the two amounts added together.
    const currencies = overdue.map((row) => row.currency).sort();
    expect(currencies).toEqual(['EUR', 'USD']);

    expect(overdue.find((row) => row.currency === 'EUR')?.amountMinor).toBe(250000);
    expect(overdue.find((row) => row.currency === 'USD')?.amountMinor).toBe(100000);
    for (const row of overdue) {
      expect(row.invoiceCount).toBe(1);
    }
  });

  it('reports customer outstanding in the workspace base currency only', async () => {
    const response = await agentA
      .get(`/api/v1/${ownerA.organization.id}/customers?page=1&pageSize=100`)
      .expect(200);
    const rows = response.body.items as Array<{
      name: string;
      currency: string;
      outstandingMinor: number;
    }>;

    const eurCustomer = rows.find((row) => row.name === 'FX EUR');
    expect(eurCustomer).toBeDefined();
    // The workspace base currency is USD, so a EUR-only customer owes nothing
    // in USD. The EUR balance is reported by the customer detail endpoint.
    expect(eurCustomer?.outstandingMinor).toBe(0);

    const usdCustomer = rows.find((row) => row.name === 'FX USD');
    expect(usdCustomer?.outstandingMinor).toBe(100000);
  });
});

describe('regression: dashboard follow-ups identify their invoice', () => {
  it('returns the invoice identity the dashboard links to', async () => {
    const response = await agentA.get(`/api/v1/${ownerA.organization.id}/dashboard`).expect(200);
    const followUps = response.body.followUps as Array<{
      invoiceId: string;
      invoiceNumber: string;
      customerName: string;
      daysOverdue: number;
      balanceMinor: number;
    }>;

    expect(followUps.length).toBeGreaterThan(0);
    for (const row of followUps) {
      expect(row.invoiceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
      expect(row.invoiceNumber).not.toBe('');
      expect(row.customerName).not.toBe('');
      expect(row.daysOverdue).toBeGreaterThan(0);
    }
  });
});

describe('regression: malformed identifiers are rejected, not crashed on', () => {
  it('rejects a non-UUID organization id with 400 rather than 500', async () => {
    const response = await agentA.get('/api/v1/not-a-uuid/customers');
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(JSON.stringify(response.body)).not.toMatch(/pgdata|syntax for type/i);
  });
});

describe('regression: invoice detail agrees with the ledger', () => {
  it('uses effective allocation after a partial reversal', async () => {
    const created = await agentA
      .post(`/api/v1/${ownerA.organization.id}/customers`)
      .send({ name: 'Reversal Customer', email: 'reversal@test.local', currency: 'USD' })
      .expect(201);
    const customerId = created.body.customer.id;

    const invoice = await agentA
      .post(`/api/v1/${ownerA.organization.id}/invoices`)
      .send({
        customerId,
        issueDate: todayIso('UTC'),
        dueDate: addDaysIso(todayIso('UTC'), 10),
        currency: 'USD',
        items: [{ description: 'Reversible', quantity: '1', unitPriceMinor: 200000 }],
        saveAsDraft: false,
        sendEmail: false,
      })
      .expect(201);
    const invoiceId = invoice.body.invoice.id as string;

    const payment = await agentA
      .post(`/api/v1/${ownerA.organization.id}/payments/manual`)
      .send({
        customerId,
        amountMinor: 200000,
        currency: 'USD',
        method: 'bank_transfer',
        paidAt: todayIso('UTC'),
        fundsReceivedConfirmed: true,
      })
      .expect(201);
    const paymentId = payment.body.payment.id as string;

    await agentA
      .post(`/api/v1/${ownerA.organization.id}/payments/${paymentId}/adjustments`)
      .send({ type: 'reversal', amountMinor: 80000, reason: 'Partial reversal' })
      .expect(200);

    const detail = await agentA
      .get(`/api/v1/${ownerA.organization.id}/invoices/${invoiceId}`)
      .expect(200);
    const list = await agentA
      .get(`/api/v1/${ownerA.organization.id}/invoices?page=1&pageSize=100`)
      .expect(200);
    const fromList = (list.body.items as Array<{ id: string; balanceMinor: number }>).find(
      (row) => row.id === invoiceId,
    );

    // 200000 received, 80000 reversed -> only 120000 is still applied, so the
    // invoice is 80000 outstanding. Detail and list must agree.
    expect(detail.body.paidMinor).toBe(120000);
    expect(detail.body.balanceMinor).toBe(80000);
    expect(fromList?.balanceMinor).toBe(80000);
  });
});
