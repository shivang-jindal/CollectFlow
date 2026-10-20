/**
 * Payments (Part B / B3.6, B4, B7).
 *
 * The ledger is append-only. Nothing is ever edited or deleted:
 *   - `payments` rows record an immutable money-in event.
 *   - `payment_allocations` link it to invoices.
 *   - `payment_adjustments` record refunds, reversals and chargebacks.
 *
 * A provider-reported payment is only ever created from a signature-verified
 * webhook, deduplicated on the provider transaction id.
 */

import { and, asc, count, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';

import { todayIso, type Paginated } from '@collectflow/shared';

import type { AppDatabase } from '../db/client.js';
import { allocatedForInvoiceTable } from '../db/balance-sql.js';
import {
  auditEvents,
  customers,
  invoices,
  paymentAdjustments,
  paymentAllocations,
  payments,
} from '../db/schema.js';
import { notFound, unprocessable } from '../errors.js';
import type { AuditService } from './audit.service.js';
import type { InvoiceService } from './invoice.service.js';

type Tx = Parameters<Parameters<AppDatabase['transaction']>[0]>[0];

export interface PaymentListItem {
  id: string;
  customerId: string;
  customerName: string;
  amountMinor: number;
  allocatedMinor: number;
  unallocatedMinor: number;
  currency: string;
  method: string;
  source: string;
  providerName: string | null;
  providerTransactionId: string | null;
  reference: string | null;
  paidAt: string;
  status: string;
  createdAt: string;
  invoiceIds: string[];
}

export class PaymentService {
  constructor(
    private readonly db: AppDatabase,
    private readonly audit: AuditService,
    private readonly invoices: InvoiceService,
  ) {}

  async list(
    organizationId: string,
    query: {
      page: number;
      pageSize: number;
      q?: string;
      customerId?: string;
      invoiceId?: string;
      method?: string;
      status: string;
      from?: string;
      to?: string;
      sort: string;
      order: 'asc' | 'desc';
    },
  ): Promise<Paginated<PaymentListItem>> {
    const filters = [eq(payments.organizationId, organizationId)];
    if (query.customerId) filters.push(eq(payments.customerId, query.customerId));
    if (query.method) filters.push(eq(payments.method, query.method));
    if (query.status && query.status !== 'all') filters.push(eq(payments.status, query.status));
    if (query.from) filters.push(sql`${payments.paidAt} >= ${query.from}`);
    if (query.to) filters.push(sql`${payments.paidAt} <= ${query.to}`);
    if (query.q) {
      const needle = `%${query.q.replace(/[%_]/g, (match) => `\\${match}`)}%`;
      filters.push(
        or(ilike(payments.reference, needle), ilike(customers.name, needle))!,
      );
    }
    if (query.invoiceId) {
      filters.push(
        sql`exists (
          select 1 from payment_allocations pa
           where pa.payment_id = ${payments.id} and pa.invoice_id = ${query.invoiceId}
        )`,
      );
    }
    const where = and(...filters);

    const orderColumn =
      query.sort === 'amount_minor'
        ? payments.amountMinor
        : query.sort === 'created_at'
          ? payments.createdAt
          : payments.paidAt;

    const rows = await this.db
      .select({
        id: payments.id,
        customerId: payments.customerId,
        customerName: customers.name,
        amountMinor: payments.amountMinor,
        currency: payments.currency,
        method: payments.method,
        source: payments.source,
        providerName: payments.providerName,
        providerTransactionId: payments.providerTransactionId,
        reference: payments.reference,
        paidAt: payments.paidAt,
        status: payments.status,
        createdAt: payments.createdAt,
      })
      .from(payments)
      .innerJoin(customers, eq(customers.id, payments.customerId))
      .where(where)
      .orderBy(query.order === 'asc' ? asc(orderColumn) : desc(orderColumn))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize);

    const ids = rows.map((row) => row.id);
    const allocationRows = ids.length
      ? await this.db
          .select({
            paymentId: paymentAllocations.paymentId,
            amount: sql<number>`coalesce(sum(${paymentAllocations.amountMinor}), 0)::bigint`,
            invoiceIds: sql<string[]>`array_agg(${paymentAllocations.invoiceId}::text)`,
          })
          .from(paymentAllocations)
          .where(inArray(paymentAllocations.paymentId, ids))
          .groupBy(paymentAllocations.paymentId)
      : [];
    const byPayment = new Map(
      allocationRows.map((row) => [row.paymentId, { amount: Number(row.amount), invoiceIds: row.invoiceIds ?? [] }]),
    );

    const countRows = await this.db.select({ total: count() }).from(payments).where(where);
    const totalCount = countRows[0]?.total ?? 0;

    return {
      items: rows.map((row) => {
        const allocated = byPayment.get(row.id);
        const amount = Number(row.amountMinor);
        return {
          ...row,
          amountMinor: amount,
          allocatedMinor: allocated?.amount ?? 0,
          unallocatedMinor: amount - (allocated?.amount ?? 0),
          paidAt: toDateString(row.paidAt),
          createdAt: row.createdAt.toISOString(),
          invoiceIds: allocated?.invoiceIds ?? [],
        };
      }),
      page: query.page,
      pageSize: query.pageSize,
      total: totalCount,
      totalPages: Math.max(1, Math.ceil(totalCount / query.pageSize)),
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Manual recording                                                       */
  /* ---------------------------------------------------------------------- */

  async recordManual(
    organizationId: string,
    actorUserId: string,
    input: {
      customerId: string;
      amountMinor: number;
      currency: string;
      method: string;
      paidAt: string;
      reference?: string | null;
      allocations?: Array<{ invoiceId: string; amountMinor: number }>;
      requestId?: string | null;
    },
  ) {
    const customer = await this.db
      .select({ id: customers.id, status: customers.status })
      .from(customers)
      .where(and(eq(customers.id, input.customerId), eq(customers.organizationId, organizationId)))
      .limit(1);
    if (!customer[0]) throw notFound('Customer');

    if (input.paidAt > todayIso('UTC')) {
      throw unprocessable('A payment date cannot be in the future.', {
        paidAt: ['Choose today or an earlier date'],
      });
    }

    let allocations = input.allocations;
    if (!allocations || allocations.length === 0) {
      allocations = await this.autoAllocate(organizationId, input.customerId, input.currency, input.amountMinor);
    }

    const allocatedTotal = allocations.reduce((sum, item) => sum + item.amountMinor, 0);
    if (allocatedTotal !== input.amountMinor) {
      throw unprocessable(
        `Allocations total ${formatAmount(allocatedTotal, input.currency)} but the payment is ${formatAmount(input.amountMinor, input.currency)}. Allocate the full amount or reduce the payment.`,
      );
    }

    return this.db.transaction(async (tx) => {
      await this.assertAllocations(tx, organizationId, input.customerId, input.currency, allocations!);

      const inserted = await tx
        .insert(payments)
        .values({
          organizationId,
          customerId: input.customerId,
          amountMinor: input.amountMinor,
          currency: input.currency,
          method: input.method,
          source: 'manual',
          reference: input.reference ?? null,
          paidAt: input.paidAt,
          status: 'recorded',
          createdBy: actorUserId,
        })
        .returning();

      const payment = inserted[0]!;
      await tx.insert(paymentAllocations).values(
        allocations!.map((item) => ({
          organizationId,
          paymentId: payment.id,
          invoiceId: item.invoiceId,
          amountMinor: item.amountMinor,
        })),
      );

      const updatedInvoices: Array<{ id: string; status: string }> = [];
      for (const allocation of allocations!) {
        const result = await this.invoices.recomputeStatus(tx, organizationId, allocation.invoiceId);
        updatedInvoices.push({ id: allocation.invoiceId, status: result.status });
      }

      await tx.insert(auditEvents).values({
        organizationId,
        actorUserId,
        action: 'payment.recorded_manual',
        entityType: 'payment',
        entityId: payment.id,
        metadata: {
          amountMinor: input.amountMinor,
          currency: input.currency,
          method: input.method,
          allocations: allocations!.length,
        },
        requestId: input.requestId ?? null,
      });

      return {
        payment: {
          ...payment,
          amountMinor: Number(payment.amountMinor),
          paidAt: toDateString(payment.paidAt),
        },
        updatedInvoices,
      };
    });
  }

  /** Allocate an existing payment (for example a bank transfer) to invoices. */
  async allocate(
    organizationId: string,
    actorUserId: string,
    paymentId: string,
    allocations: Array<{ invoiceId: string; amountMinor: number }>,
    options: { requestId?: string | null } = {},
  ) {
    const rows = await this.db
      .select()
      .from(payments)
      .where(and(eq(payments.id, paymentId), eq(payments.organizationId, organizationId)))
      .limit(1);
    const payment = rows[0];
    if (!payment) throw notFound('Payment');
    if (payment.status !== 'recorded') {
      throw unprocessable(`This payment is ${payment.status} and can no longer be allocated.`);
    }

    const existing = await this.db
      .select({ amount: sql<number>`coalesce(sum(${paymentAllocations.amountMinor}), 0)::bigint` })
      .from(paymentAllocations)
      .where(eq(paymentAllocations.paymentId, paymentId));
    const alreadyAllocated = Number(existing[0]?.amount ?? 0);
    const remaining = Number(payment.amountMinor) - alreadyAllocated;

    const requested = allocations.reduce((sum, item) => sum + item.amountMinor, 0);
    if (requested > remaining) {
      throw unprocessable(
        `Only ${formatAmount(remaining, payment.currency)} of this payment is still unallocated.`,
      );
    }

    return this.db.transaction(async (tx) => {
      await this.assertAllocations(
        tx,
        organizationId,
        payment.customerId,
        payment.currency,
        allocations,
        paymentId,
      );
      await tx.insert(paymentAllocations).values(
        allocations.map((item) => ({
          organizationId,
          paymentId,
          invoiceId: item.invoiceId,
          amountMinor: item.amountMinor,
        })),
      );
      const updatedInvoices: Array<{ id: string; status: string }> = [];
      for (const allocation of allocations) {
        const result = await this.invoices.recomputeStatus(tx, organizationId, allocation.invoiceId);
        updatedInvoices.push({ id: allocation.invoiceId, status: result.status });
      }
      await this.audit.record({
        organizationId,
        actorUserId,
        action: 'payment.allocated',
        entityType: 'payment',
        entityId: paymentId,
        metadata: { allocations },
        requestId: options.requestId ?? null,
      });
      return { updatedInvoices };
    });
  }

  /**
   * Refund / reversal / chargeback. The original payment row is preserved and
   * the invoice balances are recalculated from the reversal.
   */
  async addAdjustment(
    organizationId: string,
    actorUserId: string,
    paymentId: string,
    input: {
      type: 'refund' | 'reversal' | 'chargeback';
      amountMinor: number;
      reason: string;
      externalReference?: string | null;
      requestId?: string | null;
    },
  ) {
    const rows = await this.db
      .select()
      .from(payments)
      .where(and(eq(payments.id, paymentId), eq(payments.organizationId, organizationId)))
      .limit(1);
    const payment = rows[0];
    if (!payment) throw notFound('Payment');

    const adjustments = await this.db
      .select({ amount: sql<number>`coalesce(sum(${paymentAdjustments.amountMinor}), 0)::bigint` })
      .from(paymentAdjustments)
      .where(eq(paymentAdjustments.paymentId, paymentId));
    const alreadyReversed = Number(adjustments[0]?.amount ?? 0);
    const reversible = Number(payment.amountMinor) - alreadyReversed;
    if (input.amountMinor > reversible) {
      throw unprocessable(
        `Only ${formatAmount(reversible, payment.currency)} of this payment can still be reversed.`,
      );
    }

    return this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(paymentAdjustments)
        .values({
          organizationId,
          paymentId,
          type: input.type,
          amountMinor: input.amountMinor,
          reason: input.reason,
          externalReference: input.externalReference ?? null,
          createdBy: actorUserId,
        })
        .returning({ id: paymentAdjustments.id });

      const totalReversed = alreadyReversed + input.amountMinor;
      const newStatus =
        totalReversed >= Number(payment.amountMinor)
          ? input.type === 'refund'
            ? 'refunded'
            : input.type === 'chargeback'
              ? 'chargeback'
              : 'reversed'
          : payment.status;
      await tx.update(payments).set({ status: newStatus }).where(eq(payments.id, paymentId));

      const affected = await tx
        .select({ invoiceId: paymentAllocations.invoiceId })
        .from(paymentAllocations)
        .where(eq(paymentAllocations.paymentId, paymentId));

      const updatedInvoices: Array<{ id: string; status: string }> = [];
      for (const row of affected) {
        const result = await this.invoices.recomputeStatus(tx, organizationId, row.invoiceId);
        updatedInvoices.push({ id: row.invoiceId, status: result.status });
      }

      // The audit row must be written through the SAME transaction handle.
      // Using `this.db` here would run on a different connection, which both
      // breaks atomicity and deadlocks a single-connection driver such as
      // PGlite.
      await tx.insert(auditEvents).values({
        organizationId,
        actorUserId,
        action: `payment.${input.type}_recorded`,
        entityType: 'payment',
        entityId: paymentId,
        metadata: { amountMinor: input.amountMinor, reason: input.reason },
        requestId: input.requestId ?? null,
      });
      return { adjustmentId: inserted[0]!.id, paymentStatus: newStatus, updatedInvoices };
    });
  }

  /**
   * Provider-confirmed payment. Deduplicated on
   * `(organization_id, provider, provider_transaction_id)`, so replaying the
   * same webhook cannot create a second payment.
   */
  async recordProviderPayment(input: {
    organizationId: string;
    customerId: string;
    amountMinor: number;
    currency: string;
    providerName: string;
    providerTransactionId: string;
    paidAt: string;
    reference?: string | null;
    /** Membership owner of the integration; recorded as the creating actor. */
    createdBy: string;
  }): Promise<{ paymentId: string; deduplicated: boolean }> {
    const existing = await this.db
      .select({ id: payments.id })
      .from(payments)
      .where(
        and(
          eq(payments.organizationId, input.organizationId),
          eq(payments.providerName, input.providerName),
          eq(payments.providerTransactionId, input.providerTransactionId),
        ),
      )
      .limit(1);
    if (existing[0]) return { paymentId: existing[0].id, deduplicated: true };

    const inserted = await this.db
      .insert(payments)
      .values({
        organizationId: input.organizationId,
        customerId: input.customerId,
        amountMinor: input.amountMinor,
        currency: input.currency,
        method: 'provider',
        source: 'provider',
        providerName: input.providerName,
        providerTransactionId: input.providerTransactionId,
        reference: input.reference ?? null,
        paidAt: input.paidAt,
        status: 'recorded',
        createdBy: input.createdBy,
      })
      .returning({ id: payments.id });
    return { paymentId: inserted[0]!.id, deduplicated: false };
  }

  /* ---------------------------------------------------------------------- */
  /* Helpers                                                                */
  /* ---------------------------------------------------------------------- */

  /** Oldest-first allocation of an amount to the customer's open invoices. */
  private async autoAllocate(
    organizationId: string,
    customerId: string,
    currency: string,
    amountMinor: number,
  ): Promise<Array<{ invoiceId: string; amountMinor: number }>> {
    const rows = await this.db
      .select({
        id: invoices.id,
        totalMinor: invoices.totalMinor,
        allocated: allocatedForInvoiceTable(organizationId),
      })
      .from(invoices)
      .where(
        and(
          eq(invoices.organizationId, organizationId),
          eq(invoices.customerId, customerId),
          eq(invoices.currency, currency),
          inArray(invoices.status, ['sent', 'partially_paid']),
        ),
      )
      .orderBy(asc(invoices.issueDate), asc(invoices.invoiceNumber));

    let remaining = amountMinor;
    const result: Array<{ invoiceId: string; amountMinor: number }> = [];
    for (const row of rows) {
      if (remaining <= 0) break;
      const balance = Number(row.totalMinor) - Number(row.allocated);
      if (balance <= 0) continue;
      const take = Math.min(balance, remaining);
      result.push({ invoiceId: row.id, amountMinor: take });
      remaining -= take;
    }

    if (remaining > 0) {
      const covered = amountMinor - remaining;
      throw unprocessable(
        covered === 0
          ? `There are no sent invoices with an outstanding balance for this customer in ${currency}, so the payment cannot be allocated automatically. Record it against specific invoices, or send the invoice first.`
          : `Only ${formatAmount(covered, currency)} of open invoices could be covered. Record the payment against the invoices manually, or void the surplus.`,
      );
    }
    return result;
  }

  private async assertAllocations(
    tx: Tx,
    organizationId: string,
    customerId: string,
    currency: string,
    allocations: Array<{ invoiceId: string; amountMinor: number }>,
    excludePaymentId?: string,
  ): Promise<void> {
    for (const allocation of allocations) {
      // When re-allocating an existing payment, its own allocations are excluded
      // from the "already allocated" figure.
      // Outstanding balance for the validation query: the effective amount
      // after any reversals, excluding the payment currently being allocated.
      const allocatedSubquery = excludePaymentId
        ? sql<number>`(
            select coalesce(sum(
              round(
                pa.amount_minor::numeric
                * (p.amount_minor - least(coalesce(adj.reversed_minor, 0), p.amount_minor))::numeric
                / p.amount_minor::numeric
              )
            ), 0)::bigint
              from payment_allocations pa
              join payments p
                on p.id = pa.payment_id
               and p.organization_id = pa.organization_id
              left join (
                select payment_id, sum(amount_minor) as reversed_minor
                  from payment_adjustments
                 group by payment_id
              ) adj on adj.payment_id = pa.payment_id
             where pa.invoice_id = ${invoices.id}
               and pa.organization_id = ${organizationId}
               and pa.payment_id <> ${excludePaymentId}
          )`
        : allocatedForInvoiceTable(organizationId);

      const rows = await tx
        .select({
          id: invoices.id,
          invoiceNumber: invoices.invoiceNumber,
          customerId: invoices.customerId,
          currency: invoices.currency,
          status: invoices.status,
          totalMinor: invoices.totalMinor,
          allocated: allocatedSubquery,
        })
        .from(invoices)
        .where(and(eq(invoices.id, allocation.invoiceId), eq(invoices.organizationId, organizationId)))
        .limit(1);

      const invoice = rows[0];
      if (!invoice) throw notFound('Invoice');
      if (invoice.customerId !== customerId) {
        throw unprocessable('Every allocated invoice must belong to the payment customer.');
      }
      if (invoice.currency !== currency) {
        throw unprocessable(
          `Invoice ${invoice.invoiceNumber} is in ${invoice.currency} but the payment is in ${currency}. Convert the payment first; CollectFlow never adds different currencies together.`,
        );
      }
      if (invoice.status === 'void') {
        throw unprocessable(`Invoice ${invoice.invoiceNumber} is voided and cannot receive a payment.`);
      }
      const balance = Number(invoice.totalMinor) - Number(invoice.allocated);
      if (allocation.amountMinor > balance) {
        throw unprocessable(
          `Invoice ${invoice.invoiceNumber} has ${formatAmount(balance, currency)} outstanding; ${formatAmount(allocation.amountMinor, currency)} cannot be allocated to it.`,
        );
      }
    }
  }
}

function toDateString(value: Date | string): string {
  if (typeof value === 'string') return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}

function formatAmount(minor: number, currency: string): string {
  return `${(minor / 100).toFixed(2)} ${currency}`;
}