/**
 * Dashboard and receivable reports (Part B / B3.1, B3.8).
 *
 * Every figure is computed from persisted rows and carries a documented
 * definition. Amounts in different currencies are grouped, never summed
 * (Part B / B7).
 */

import { and, asc, count, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';

import {
  AGING_BUCKETS,
  daysBetweenIso,
  groupByCurrency,
  todayIso,
  type AgingBucket,
} from '@collectflow/shared';

import type { AppDatabase } from '../db/client.js';
import { allocatedForInvoiceTable } from '../db/balance-sql.js';
import { customers, invoices, payments } from '../db/schema.js';

const OPEN_STATUSES = ['sent', 'partially_paid'];

export interface DashboardSummary {
  range: { from: string; to: string };
  currencyGroups: Array<{ currency: string; amountMinor: number }>;
  outstanding: Array<{ currency: string; amountMinor: number }>;
  overdue: Array<{ currency: string; amountMinor: number }>;
  collectedThisMonth: Array<{ currency: string; amountMinor: number }>;
  awaitingPaymentCount: number;
  overdueCount: number;
  draftCount: number;
  customerCount: number;
  recentInvoices: Array<{
    id: string;
    invoiceNumber: string;
    customerName: string;
    issueDate: string;
    dueDate: string | null;
    currency: string;
    totalMinor: number;
    balanceMinor: number;
    status: string;
    displayStatus: string;
  }>;
  recentPayments: Array<{
    id: string;
    customerName: string;
    amountMinor: number;
    currency: string;
    method: string;
    source: string;
    paidAt: string;
  }>;
  followUps: Array<{
    invoiceId: string;
    invoiceNumber: string;
    customerName: string;
    dueDate: string;
    daysOverdue: number;
    currency: string;
    balanceMinor: number;
  }>;
  collectedByMonth: Array<{ month: string; currency: string; amountMinor: number }>;
  definitions: Record<string, string>;
}

export interface ReceivablesReport {
  asOf: string;
  totalsByCurrency: Array<{ currency: string; amountMinor: number }>;
  buckets: Array<{
    bucket: AgingBucket;
    label: string;
    /** Null when the bucket is empty. Never mixed with other currencies. */
    currency: string | null;
    amountMinor: number;
    invoiceCount: number;
  }>;
  byCustomer: Array<{
    customerId: string;
    customerName: string;
    currency: string;
    amountMinor: number;
    oldestDueDate: string | null;
  }>;
  excluded: { voidInvoices: number };
}

export class ReportService {
  constructor(private readonly db: AppDatabase) {}

  async dashboard(
    organizationId: string,
    timezone: string,
    range: { from?: string; to?: string },
  ): Promise<DashboardSummary> {
    const today = todayIso(timezone);
    const to = range.to ?? today;
    const from = range.from ?? `${to.slice(0, 7)}-01`;
    const monthStart = `${today.slice(0, 7)}-01`;

    const allocatedExpr = allocatedForInvoiceTable(organizationId);
    const balanceExpr = sql<number>`(${invoices.totalMinor} - ${allocatedExpr})::bigint`;

    const openInvoices = await this.db
      .select({
        currency: invoices.currency,
        balance: balanceExpr,
        dueDate: invoices.dueDate,
      })
      .from(invoices)
      .where(
        and(
          eq(invoices.organizationId, organizationId),
          inArray(invoices.status, OPEN_STATUSES),
        ),
      );

    const outstanding = openInvoices
      .map((row) => ({ currency: row.currency, amountMinor: Number(row.balance) }))
      .filter((row) => row.amountMinor > 0);
    const overdue = openInvoices
      .filter((row) => row.dueDate && toDate(row.dueDate) < today)
      .map((row) => ({ currency: row.currency, amountMinor: Number(row.balance) }));
    const awaitingPaymentCount = openInvoices.filter((row) => Number(row.balance) > 0).length;
    const overdueCount = overdue.length;

    const collectedRows = await this.db
      .select({
        currency: payments.currency,
        amount: sql<number>`coalesce(sum(${payments.amountMinor}), 0)::bigint`,
      })
      .from(payments)
      .where(
        and(
          eq(payments.organizationId, organizationId),
          eq(payments.status, 'recorded'),
          gte(payments.paidAt, monthStart),
          lte(payments.paidAt, today),
        ),
      )
      .groupBy(payments.currency);

    const collected = collectedRows.map((row) => ({
      currency: row.currency,
      amountMinor: Number(row.amount),
    }));

    const draftRows = await this.db
      .select({ total: count() })
      .from(invoices)
      .where(and(eq(invoices.organizationId, organizationId), eq(invoices.status, 'draft')));
    const customerRows = await this.db
      .select({ total: count() })
      .from(customers)
      .where(and(eq(customers.organizationId, organizationId), eq(customers.status, 'active')));

    const recentInvoices = await this.db
      .select({
        id: invoices.id,
        invoiceNumber: invoices.invoiceNumber,
        customerName: customers.name,
        issueDate: invoices.issueDate,
        dueDate: invoices.dueDate,
        currency: invoices.currency,
        totalMinor: invoices.totalMinor,
        status: invoices.status,
        balance: balanceExpr,
      })
      .from(invoices)
      .innerJoin(customers, eq(customers.id, invoices.customerId))
      .where(eq(invoices.organizationId, organizationId))
      .orderBy(desc(invoices.updatedAt))
      .limit(8);

    const recentPayments = await this.db
      .select({
        id: payments.id,
        customerName: customers.name,
        amountMinor: payments.amountMinor,
        currency: payments.currency,
        method: payments.method,
        source: payments.source,
        paidAt: payments.paidAt,
      })
      .from(payments)
      .innerJoin(customers, eq(customers.id, payments.customerId))
      .where(eq(payments.organizationId, organizationId))
      .orderBy(desc(payments.paidAt))
      .limit(8);

    // Follow-ups need the invoice identity, so they are selected in one query
    // rather than assembled from a placeholder lookup.
    const followUps = (
      await this.db
        .select({
          invoiceId: invoices.id,
          invoiceNumber: invoices.invoiceNumber,
          customerName: customers.name,
          dueDate: invoices.dueDate,
          currency: invoices.currency,
          balance: balanceExpr,
        })
        .from(invoices)
        .innerJoin(customers, eq(customers.id, invoices.customerId))
        .where(
          and(
            eq(invoices.organizationId, organizationId),
            inArray(invoices.status, OPEN_STATUSES),
            lte(invoices.dueDate, today),
          ),
        )
        .orderBy(asc(invoices.dueDate))
        .limit(8)
    )
      .filter((row) => Number(row.balance) > 0)
      .map((row) => ({
        invoiceId: row.invoiceId,
        invoiceNumber: row.invoiceNumber,
        customerName: row.customerName,
        dueDate: toDate(row.dueDate!),
        daysOverdue: Math.max(0, daysBetweenIso(toDate(row.dueDate!), today)),
        currency: row.currency,
        balanceMinor: Number(row.balance),
      }));

    const collectedByMonthRows = await this.db
      .select({
        month: sql<string>`to_char(${payments.paidAt}, 'YYYY-MM')`,
        currency: payments.currency,
        amount: sql<number>`coalesce(sum(${payments.amountMinor}), 0)::bigint`,
      })
      .from(payments)
      .where(
        and(
          eq(payments.organizationId, organizationId),
          gte(payments.paidAt, from),
          lte(payments.paidAt, to),
        ),
      )
      .groupBy(sql`to_char(${payments.paidAt}, 'YYYY-MM')`, payments.currency)
      .orderBy(sql`to_char(${payments.paidAt}, 'YYYY-MM')`);

    return {
      range: { from, to },
      currencyGroups: groupByCurrency([
        ...outstanding,
        ...collected,
      ]),
      outstanding: groupByCurrency(outstanding),
      overdue: groupByCurrency(overdue),
      collectedThisMonth: collected,
      awaitingPaymentCount,
      overdueCount,
      draftCount: draftRows[0]?.total ?? 0,
      customerCount: customerRows[0]?.total ?? 0,
      recentInvoices: recentInvoices.map((row) => {
        const balance = row.status === 'void' ? 0 : Number(row.balance);
        return {
          id: row.id,
          invoiceNumber: row.invoiceNumber,
          customerName: row.customerName,
          issueDate: toDate(row.issueDate),
          dueDate: row.dueDate ? toDate(row.dueDate) : null,
          currency: row.currency,
          totalMinor: Number(row.totalMinor),
          balanceMinor: balance,
          status: row.status,
          displayStatus: deriveStatus(row.status, row.dueDate ? toDate(row.dueDate) : null, balance, today),
        };
      }),
      recentPayments: recentPayments.map((row) => ({
        ...row,
        amountMinor: Number(row.amountMinor),
        paidAt: toDate(row.paidAt),
      })),
      followUps,
      collectedByMonth: collectedByMonthRows.map((row) => ({
        month: row.month,
        currency: row.currency,
        amountMinor: Number(row.amount),
      })),
      definitions: {
        outstanding:
          'Total of sent and partially paid invoices that still have a balance, excluding void invoices.',
        overdue:
          'Outstanding balance on sent or partially paid invoices whose due date is before today (organization timezone).',
        collectedThisMonth:
          'Payments recorded with status "recorded" and a payment date inside the current calendar month. Manual and provider payments are both included.',
        awaitingPaymentCount: 'Number of sent or partially paid invoices with a balance greater than zero.',
        currencyGrouping:
          'Amounts are grouped per currency. Different currencies are never added together because CollectFlow does not store exchange rates.',
      },
    };
  }

  async receivables(
    organizationId: string,
    options: { asOf?: string; currency?: string },
  ): Promise<ReceivablesReport> {
    const asOf = options.asOf ?? todayIso('UTC');
    const allocatedExpr = allocatedForInvoiceTable(organizationId);
    const balanceExpr = sql<number>`(${invoices.totalMinor} - ${allocatedExpr})::bigint`;

    const filters = [
      eq(invoices.organizationId, organizationId),
      inArray(invoices.status, OPEN_STATUSES),
    ];
    if (options.currency) filters.push(eq(invoices.currency, options.currency));

    const rows = await this.db
      .select({
        id: invoices.id,
        invoiceNumber: invoices.invoiceNumber,
        customerId: invoices.customerId,
        customerName: customers.name,
        currency: invoices.currency,
        dueDate: invoices.dueDate,
        balance: balanceExpr,
      })
      .from(invoices)
      .innerJoin(customers, eq(customers.id, invoices.customerId))
      .where(and(...filters));

    const buckets: Record<string, { currency: string; amountMinor: number; invoiceCount: number }[]> = {};
    for (const bucket of AGING_BUCKETS) buckets[bucket] = [];

    const perCustomer = new Map<string, { name: string; currency: string; amountMinor: number; oldest: string | null }>();

    for (const row of rows) {
      const balance = Number(row.balance);
      if (balance <= 0) continue;
      const bucket = bucketFor(row.dueDate ? toDate(row.dueDate) : null, asOf);
      buckets[bucket]!.push({ currency: row.currency, amountMinor: balance, invoiceCount: 1 });

      const key = `${row.customerId}:${row.currency}`;
      const entry = perCustomer.get(key);
      const due = row.dueDate ? toDate(row.dueDate) : null;
      if (entry) {
        entry.amountMinor += balance;
        if (due && (!entry.oldest || due < entry.oldest)) entry.oldest = due;
      } else {
        perCustomer.set(key, {
          name: row.customerName,
          currency: row.currency,
          amountMinor: balance,
          oldest: due,
        });
      }
    }

    const voidRows = await this.db
      .select({ total: count() })
      .from(invoices)
      .where(and(eq(invoices.organizationId, organizationId), eq(invoices.status, 'void')));

    return {
      asOf,
      totalsByCurrency: groupByCurrency(
        AGING_BUCKETS.flatMap((bucket) => buckets[bucket]!.map((b) => ({ currency: b.currency, amountMinor: b.amountMinor }))),
      ),
      /**
       * A bucket is reported PER CURRENCY. `amountMinor` on its own would add
       * different currencies together, which CollectFlow never does (B7); the
       * client sums a bucket only when exactly one currency is present and
       * shows the per-currency split otherwise.
       */
      buckets: AGING_BUCKETS.flatMap((bucket): Array<{
        bucket: AgingBucket;
        label: string;
        currency: string | null;
        amountMinor: number;
        invoiceCount: number;
      }> => {
        const entries = groupByCurrency(
          buckets[bucket]!.map((b) => ({ currency: b.currency, amountMinor: b.amountMinor })),
        );
        if (entries.length === 0) {
          return [{ bucket, label: LABELS[bucket]!, currency: null, amountMinor: 0, invoiceCount: 0 }];
        }
        return entries.map((entry) => ({
          bucket,
          label: LABELS[bucket]!,
          currency: entry.currency,
          amountMinor: entry.amountMinor,
          invoiceCount: buckets[bucket]!.filter((b) => b.currency === entry.currency).length,
        }));
      }),
      byCustomer: [...perCustomer.entries()]
        .map(([key, value]) => {
          const [customerId] = key.split(':');
          return {
            customerId: customerId!,
            customerName: value.name,
            currency: value.currency,
            amountMinor: value.amountMinor,
            oldestDueDate: value.oldest,
          };
        })
        .sort((a, b) => b.amountMinor - a.amountMinor)
        .slice(0, 50),
      excluded: { voidInvoices: voidRows[0]?.total ?? 0 },
    };
  }

  async collections(
    organizationId: string,
    range: { from?: string; to?: string },
  ) {
    const from = range.from ?? `${todayIso('UTC').slice(0, 4)}-01-01`;
    const to = range.to ?? todayIso('UTC');

    const byMonth = await this.db
      .select({
        month: sql<string>`to_char(${payments.paidAt}, 'YYYY-MM')`,
        currency: payments.currency,
        amount: sql<number>`coalesce(sum(${payments.amountMinor}), 0)::bigint`,
        count: sql<number>`count(*)::int`,
      })
      .from(payments)
      .where(
        and(
          eq(payments.organizationId, organizationId),
          gte(payments.paidAt, from),
          lte(payments.paidAt, to),
        ),
      )
      .groupBy(sql`to_char(${payments.paidAt}, 'YYYY-MM')`, payments.currency)
      .orderBy(sql`to_char(${payments.paidAt}, 'YYYY-MM')`);

    const byMethod = await this.db
      .select({
        method: payments.method,
        currency: payments.currency,
        amount: sql<number>`coalesce(sum(${payments.amountMinor}), 0)::bigint`,
        count: sql<number>`count(*)::int`,
      })
      .from(payments)
      .where(
        and(
          eq(payments.organizationId, organizationId),
          gte(payments.paidAt, from),
          lte(payments.paidAt, to),
        ),
      )
      .groupBy(payments.method, payments.currency);

    const statusCounts = await this.db
      .select({ status: invoices.status, count: sql<number>`count(*)::int` })
      .from(invoices)
      .where(eq(invoices.organizationId, organizationId))
      .groupBy(invoices.status);

    const customerBalances = await this.db
      .select({
        customerId: customers.id,
        customerName: customers.name,
        currency: invoices.currency,
        outstanding: sql<number>`coalesce(sum(${invoices.totalMinor} - ${allocatedForInvoiceTable(organizationId)}), 0)::bigint`,
      })
      .from(invoices)
      .innerJoin(customers, eq(customers.id, invoices.customerId))
      .where(
        and(
          eq(invoices.organizationId, organizationId),
          inArray(invoices.status, OPEN_STATUSES),
        ),
      )
      .groupBy(customers.id, customers.name, invoices.currency)
      .orderBy(desc(sql`sum(${invoices.totalMinor})`))
      .limit(25);

    return {
      range: { from, to },
      byMonth: byMonth.map((row) => ({ ...row, amountMinor: Number(row.amount) })),
      byMethod: byMethod.map((row) => ({ ...row, amountMinor: Number(row.amount) })),
      invoiceStatusCounts: statusCounts,
      customerBalances: customerBalances
        .map((row) => ({ ...row, outstandingMinor: Number(row.outstanding) }))
        .filter((row) => row.outstandingMinor > 0),
      notes: [
        'Void invoices are excluded from every collected and outstanding figure.',
        'Amounts are grouped per currency and never converted or added across currencies.',
        'Payments reversed, refunded or charged back keep their original row and are shown through the adjustment list.',
      ],
    };
  }
}

const LABELS: Record<AgingBucket, string> = {
  current: 'Not yet due',
  '1_30': '1-30 days overdue',
  '31_60': '31-60 days overdue',
  '61_90': '61-90 days overdue',
  '90_plus': '90+ days overdue',
};

function bucketFor(dueDate: string | null, asOf: string): AgingBucket {
  if (!dueDate) return 'current';
  const days = daysBetweenIso(dueDate, asOf);
  if (days <= 0) return 'current';
  if (days <= 30) return '1_30';
  if (days <= 60) return '31_60';
  if (days <= 90) return '61_90';
  return '90_plus';
}

function toDate(value: Date | string): string {
  if (typeof value === 'string') return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}

function deriveStatus(status: string, dueDate: string | null, balance: number, today: string): string {
  if (status === 'void') return 'void';
  if (balance <= 0 || status === 'paid') return 'paid';
  if (dueDate && dueDate < today && (status === 'sent' || status === 'partially_paid')) return 'overdue';
  return status;
}