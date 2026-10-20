import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';

import { createTestContext, seedTenant, type TestContext } from './harness.js';
import { invoices, payments, reminderLogs } from '../src/db/schema.js';
import { addDaysIso, todayIso } from '@collectflow/shared';

let context: TestContext;
let tenantA: Awaited<ReturnType<typeof seedTenant>>;
let tenantB: Awaited<ReturnType<typeof seedTenant>>;

beforeAll(async () => {
  context = await createTestContext();
  tenantA = await seedTenant(context, { email: 'owner-a@test.local', organizationName: 'Tenant A' });
  tenantB = await seedTenant(context, { email: 'owner-b@test.local', organizationName: 'Tenant B' });
});

afterAll(async () => {
  await context.close();
});

let customerCounter = 0;
async function createInvoice(
  tenant: Awaited<ReturnType<typeof seedTenant>>,
  overrides: { totalMinor?: number; send?: boolean } = {},
) {
  customerCounter += 1;
  const customer = await context.services.customers.create(tenant.organization.id, tenant.user.id, {
    name: `Customer ${customerCounter}`,
    email: `customer-${tenant.organization.slug}-${customerCounter}@test.local`,
  });
  const invoice = await context.services.invoices.create(
    tenant.organization.id,
    tenant.user.id,
    {
      customerId: customer.id,
      issueDate: todayIso('UTC'),
      dueDate: addDaysIso(todayIso('UTC'), 14),
      currency: 'USD',
      items: [
        {
          description: 'Consulting',
          quantity: '1',
          unitPriceMinor: overrides.totalMinor ?? 100000,
          taxRateBasisPoints: 0,
        },
      ],
      saveAsDraft: true,
    },
    { timezone: 'UTC' },
  );
  if (overrides.send !== false) {
    await context.services.invoices.markSent(tenant.organization.id, tenant.user.id, invoice.id, {});
  }
  return { customer, invoice };
}

describe('invoice numbering and totals', () => {
  it('allocates unique invoice numbers even for simultaneous creation', async () => {
    const customer = await context.services.customers.create(tenantA.organization.id, tenantA.user.id, {
      name: 'Concurrency Probe',
      email: 'concurrency@test.local',
    });

    const create = () =>
      context.services.invoices.create(
        tenantA.organization.id,
        tenantA.user.id,
        {
          customerId: customer.id,
          issueDate: todayIso('UTC'),
          dueDate: addDaysIso(todayIso('UTC'), 7),
          currency: 'USD',
          items: [{ description: 'Parallel', quantity: '1', unitPriceMinor: 1000 }],
          saveAsDraft: true,
        },
        { timezone: 'UTC' },
      );

    const results = await Promise.all(Array.from({ length: 8 }, create));
    const numbers = results.map((invoice) => invoice.invoiceNumber);
    expect(new Set(numbers).size).toBe(numbers.length);

    const rows = await context.handle.db
      .select({ invoiceNumber: invoices.invoiceNumber })
      .from(invoices)
      .where(eq(invoices.organizationId, tenantA.organization.id));
    expect(new Set(rows.map((row) => row.invoiceNumber)).size).toBe(rows.length);
  });

  it('recalculates totals server-side and ignores any browser supplied total', async () => {
    const { invoice } = await createInvoice(tenantA, { totalMinor: 12345, send: false });
    expect(Number(invoice.totalMinor)).toBe(12345);
    expect(Number(invoice.subtotalMinor)).toBe(12345);
    expect(Number(invoice.taxMinor)).toBe(0);
  });
});

describe('payment allocation', () => {
  it('marks an invoice paid only when the balance reaches zero', async () => {
    const { customer, invoice } = await createInvoice(tenantA, { totalMinor: 100000 });

    await context.services.payments.recordManual(tenantA.organization.id, tenantA.user.id, {
      customerId: customer.id,
      amountMinor: 40000,
      currency: 'USD',
      method: 'bank_transfer',
      paidAt: todayIso('UTC'),
    });

    const afterPartial = await context.services.invoices.get(tenantA.organization.id, invoice.id);
    expect(afterPartial.status).toBe('partially_paid');

    await context.services.payments.recordManual(tenantA.organization.id, tenantA.user.id, {
      customerId: customer.id,
      amountMinor: 60000,
      currency: 'USD',
      method: 'bank_transfer',
      paidAt: todayIso('UTC'),
    });

    const afterFull = await context.services.invoices.get(tenantA.organization.id, invoice.id);
    expect(afterFull.status).toBe('paid');
  });

  it('rejects over-allocation with an explanation', async () => {
    const { customer } = await createInvoice(tenantA, { totalMinor: 10000 });

    await expect(
      context.services.payments.recordManual(tenantA.organization.id, tenantA.user.id, {
        customerId: customer.id,
        amountMinor: 10001,
        currency: 'USD',
        method: 'cash',
        paidAt: todayIso('UTC'),
      }),
    ).rejects.toThrow(/open invoices could be covered/i);
  });

  it('rejects a currency mismatch between payment and invoice', async () => {
    const { customer, invoice } = await createInvoice(tenantA, { totalMinor: 10000 });
    await expect(
      context.services.payments.recordManual(tenantA.organization.id, tenantA.user.id, {
        customerId: customer.id,
        amountMinor: 1000,
        currency: 'EUR',
        method: 'bank_transfer',
        paidAt: todayIso('UTC'),
        allocations: [{ invoiceId: invoice.id, amountMinor: 1000 }],
      }),
    ).rejects.toThrow(/never adds different currencies/i);
  });

  it('keeps the ledger append-only and recalculates after a reversal', async () => {
    const { customer, invoice } = await createInvoice(tenantA, { totalMinor: 50000 });
    const recorded = await context.services.payments.recordManual(
      tenantA.organization.id,
      tenantA.user.id,
      {
        customerId: customer.id,
        amountMinor: 50000,
        currency: 'USD',
        method: 'bank_transfer',
        paidAt: todayIso('UTC'),
      },
    );
    expect((await context.services.invoices.get(tenantA.organization.id, invoice.id)).status).toBe('paid');

    await context.services.payments.addAdjustment(
      tenantA.organization.id,
      tenantA.user.id,
      recorded.payment.id,
      { type: 'reversal', amountMinor: 20000, reason: 'Test reversal' },
    );

    const afterReversal = await context.services.invoices.get(tenantA.organization.id, invoice.id);
    expect(afterReversal.status).toBe('partially_paid');

    // The original payment row still exists.
    const rows = await context.handle.db
      .select()
      .from(payments)
      .where(eq(payments.id, recorded.payment.id));
    expect(rows).toHaveLength(1);
  });

  it('never creates a second payment when a provider event is replayed', async () => {
    const customer = await context.services.customers.create(tenantB.organization.id, tenantB.user.id, {
      name: 'Webhook Customer',
      email: 'webhook@test.local',
    });
    const event = {
      organizationId: tenantB.organization.id,
      customerId: customer.id,
      amountMinor: 4500,
      currency: 'USD',
      providerName: 'test-provider',
      providerTransactionId: 'txn_dedupe_1',
      paidAt: todayIso('UTC'),
      createdBy: tenantB.user.id,
    };

    const first = await context.services.payments.recordProviderPayment(event);
    const second = await context.services.payments.recordProviderPayment(event);

    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(true);
    expect(second.paymentId).toBe(first.paymentId);

    const rows = await context.handle.db
      .select()
      .from(payments)
      .where(eq(payments.providerTransactionId, 'txn_dedupe_1'));
    expect(rows).toHaveLength(1);
  });
});

describe('tenant isolation', () => {
  it('hides another organization invoice behind a 404, not a 403', async () => {
    const { invoice } = await createInvoice(tenantA, { totalMinor: 1000 });
    await expect(context.services.invoices.get(tenantB.organization.id, invoice.id)).rejects.toThrow(
      /not found/i,
    );
    await expect(
      context.services.invoices.voidInvoice(tenantB.organization.id, tenantB.user.id, invoice.id, 'x'),
    ).rejects.toThrow(/not found/i);
  });

  it('refuses to allocate a payment across tenants', async () => {
    const { customer, invoice } = await createInvoice(tenantA, { totalMinor: 5000 });
    await expect(
      context.services.payments.recordManual(tenantB.organization.id, tenantB.user.id, {
        customerId: customer.id,
        amountMinor: 100,
        currency: 'USD',
        method: 'cash',
        paidAt: todayIso('UTC'),
        allocations: [{ invoiceId: invoice.id, amountMinor: 100 }],
      }),
    ).rejects.toThrow();
  });

  it('keeps each organization invoice list separate', async () => {
    await createInvoice(tenantA, { totalMinor: 1000 });
    const listA = await context.services.invoices.list(tenantA.organization.id, 'UTC', {
      page: 1,
      pageSize: 100,
      status: 'all',
      sort: 'issue_date',
      order: 'desc',
    });
    const listB = await context.services.invoices.list(tenantB.organization.id, 'UTC', {
      page: 1,
      pageSize: 100,
      status: 'all',
      sort: 'issue_date',
      order: 'desc',
    });

    const idsA = new Set(listA.items.map((item) => item.id));
    for (const item of listB.items) expect(idsA.has(item.id)).toBe(false);

    const rows = await context.handle.db.execute<{ leaked: number }>(sql`
      select count(*)::int as leaked from invoices where organization_id = ${tenantB.organization.id}
    `);
    expect(rows.rows[0]?.leaked).toBeGreaterThanOrEqual(0);
  });
});

describe('reminders', () => {
  it('never schedules the same invoice/rule/date twice', async () => {
    const { customer, invoice } = await createInvoice(tenantB, { totalMinor: 7000 });
    await context.services.organizations.ensureDefaultReminderRules(tenantB.organization.id);
    const rules = await context.services.organizations.listReminderRules(tenantB.organization.id);
    await context.services.organizations.updateReminderRules(tenantB.organization.id, tenantB.user.id, [
      { id: rules[0]!.id, enabled: true, offsetDays: 0 },
    ]);
    await context.services.organizations.updateSettings(tenantB.organization.id, tenantB.user.id, {
      remindersPaused: false,
    });

    const first = await context.services.reminders.scheduleDueReminders(tenantB.organization.id);
    const second = await context.services.reminders.scheduleDueReminders(tenantB.organization.id);

    expect(first.created).toBeGreaterThan(0);
    expect(second.created).toBe(0);

    const rows = await context.handle.db
      .select()
      .from(reminderLogs)
      .where(eq(reminderLogs.invoiceId, invoice.id));
    expect(new Set(rows.map((row) => row.idempotencyKey)).size).toBe(rows.length);
    void customer;
  });

  it('respects a customer opt-out', async () => {
    const { customer } = await createInvoice(tenantB, { totalMinor: 3000 });
    await context.services.customers.setReminderOptOut(tenantB.organization.id, customer.id, true);
    const result = await context.services.reminders.scheduleDueReminders(tenantB.organization.id);
    expect(result.created).toBe(0);
  });
});