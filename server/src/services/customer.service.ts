/**
 * Customers (Part B / B3.5).
 *
 * A customer with financial history is never deleted - only archived.
 * Outstanding balances are always derived from invoices and allocations.
 */

import { and, asc, count, desc, eq, ilike, ne, or, sql } from 'drizzle-orm';

import type { CustomerListItem, Paginated } from '@collectflow/shared';

import type { AppDatabase } from '../db/client.js';
import { allocatedForInvoiceTable, effectiveAllocatedSql } from '../db/balance-sql.js';
import {
  customers,
  invoices,
  payments,
  type Customer,
  type CustomerAddress,
} from '../db/schema.js';
import { conflict, notFound } from '../errors.js';
import type { AuditService } from './audit.service.js';

export interface CustomerInput {
  name: string;
  legalName?: string | null;
  email?: string | null;
  phone?: string | null;
  billingAddress?: CustomerAddress | null;
  taxIdentifier?: string | null;
  notes?: string | null;
  currency?: string | null;
}

export class CustomerService {
  constructor(
    private readonly db: AppDatabase,
    private readonly audit: AuditService,
  ) {}

  async list(
    organizationId: string,
    query: {
      page: number;
      pageSize: number;
      q?: string;
      status: 'active' | 'archived' | 'all';
      currency?: string;
      /** Currency the single `outstandingMinor` column is denominated in. */
      baseCurrency: string;
      sort: 'name' | 'created_at' | 'outstanding';
      order: 'asc' | 'desc';
    },
  ): Promise<Paginated<CustomerListItem>> {
    const filters = [eq(customers.organizationId, organizationId)];
    if (query.status === 'active') filters.push(eq(customers.status, 'active'));
    if (query.status === 'archived') filters.push(eq(customers.status, 'archived'));
    if (query.currency) filters.push(eq(customers.currency, query.currency));
    if (query.q) {
      const needle = `%${query.q.replace(/[%_]/g, (match) => `\\${match}`)}%`;
      filters.push(
        or(
          ilike(customers.name, needle),
          ilike(customers.email, needle),
          ilike(customers.legalName, needle),
        )!,
      );
    }
    const where = and(...filters);

    const perInvoiceAllocated = effectiveAllocatedSql(sql`i.id`, sql`${organizationId}`);
    /**
     * Outstanding balance, restricted to ONE currency.
     *
     * Amounts in different currencies are never added together (Part B / B7),
     * so the single `outstandingMinor` column only ever carries the balance in
     * the organization's base currency. The full per-currency picture is
     * returned by `getDetail`.
     *
     * Only invoices that still owe money are counted. That filter is applied
     * in an outer `WHERE` rather than a `HAVING`: inside an aggregate
     * subquery PostgreSQL rejects a `HAVING` that references a plain column.
     */
    const outstanding = sql<number>`coalesce((
      SELECT sum(open.balance)
        FROM (
          SELECT i.total_minor - ${perInvoiceAllocated} AS balance
            FROM invoices i
           WHERE i.organization_id = ${organizationId}
             AND i.customer_id = customers.id
             AND i.status <> 'void'
             AND i.currency = ${query.baseCurrency}
        ) AS open
       WHERE open.balance > 0
    ), 0)::bigint`;

    const orderBy =
      query.sort === 'name'
        ? query.order === 'asc'
          ? asc(customers.name)
          : desc(customers.name)
        : query.sort === 'created_at'
          ? query.order === 'asc'
            ? asc(customers.createdAt)
            : desc(customers.createdAt)
          : query.order === 'asc'
            ? asc(outstanding)
            : desc(outstanding);

    const rows = await this.db
      .select({
        id: customers.id,
        name: customers.name,
        legalName: customers.legalName,
        email: customers.email,
        phone: customers.phone,
        currency: customers.currency,
        taxIdentifier: customers.taxIdentifier,
        status: customers.status,
        outstandingMinor: outstanding,
        createdAt: customers.createdAt,
        invoiceCount: sql<number>`(
          SELECT count(*)::int FROM invoices i
           WHERE i.organization_id = ${organizationId}
             AND i.customer_id = customers.id
             AND i.status <> 'void'
        )`,
      })
      .from(customers)
      .where(where)
      .orderBy(orderBy)
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize);

    const countRows = await this.db
      .select({ total: count() })
      .from(customers)
      .where(where);
    const totalCount = countRows[0]?.total ?? 0;

    return {
      items: rows.map((row) => ({
        id: row.id,
        name: row.name,
        legalName: row.legalName,
        email: row.email,
        phone: row.phone,
        currency: row.currency,
        taxIdentifier: row.taxIdentifier,
        status: row.status as 'active' | 'archived',
        outstandingMinor: Number(row.outstandingMinor ?? 0),
        invoiceCount: row.invoiceCount ?? 0,
        createdAt: row.createdAt.toISOString(),
      })),
      page: query.page,
      pageSize: query.pageSize,
      total: totalCount,
      totalPages: Math.max(1, Math.ceil(totalCount / query.pageSize)),
    };
  }

  async get(organizationId: string, customerId: string): Promise<Customer> {
    const rows = await this.db
      .select()
      .from(customers)
      .where(and(eq(customers.id, customerId), eq(customers.organizationId, organizationId)))
      .limit(1);
    const row = rows[0];
    if (!row) throw notFound('Customer');
    return row;
  }

  async create(
    organizationId: string,
    actorUserId: string,
    input: CustomerInput,
    context?: { requestId?: string | null },
  ): Promise<Customer> {
    if (input.email) {
      const duplicate = await this.db
        .select({ id: customers.id })
        .from(customers)
        .where(and(eq(customers.organizationId, organizationId), eq(customers.email, input.email)))
        .limit(1);
      if (duplicate[0]) {
        throw conflict('Another customer already uses that email address.', { field: 'email' });
      }
    }
    const inserted = await this.db
      .insert(customers)
      .values({
        organizationId,
        name: input.name,
        legalName: input.legalName ?? null,
        email: input.email ?? null,
        phone: input.phone ?? null,
        billingAddress: input.billingAddress ?? null,
        taxIdentifier: input.taxIdentifier ?? null,
        notes: input.notes ?? null,
        currency: input.currency ?? null,
      })
      .returning();

    await this.audit.record({
      organizationId,
      actorUserId,
      action: 'customer.created',
      entityType: 'customer',
      entityId: inserted[0]!.id,
      metadata: { name: input.name },
      requestId: context?.requestId ?? null,
    });
    return inserted[0]!;
  }

  async update(
    organizationId: string,
    actorUserId: string,
    customerId: string,
    patch: CustomerInput,
    context?: { requestId?: string | null },
  ): Promise<Customer> {
    await this.get(organizationId, customerId);
    if (patch.email) {
      const duplicate = await this.db
        .select({ id: customers.id })
        .from(customers)
        .where(
          and(
            eq(customers.organizationId, organizationId),
            eq(customers.email, patch.email),
            ne(customers.id, customerId),
          ),
        )
        .limit(1);
      if (duplicate[0]) {
        throw conflict('Another customer already uses that email address.', { field: 'email' });
      }
    }
    const updated = await this.db
      .update(customers)
      .set({
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.legalName !== undefined ? { legalName: patch.legalName } : {}),
        ...(patch.email !== undefined ? { email: patch.email } : {}),
        ...(patch.phone !== undefined ? { phone: patch.phone } : {}),
        ...(patch.billingAddress !== undefined ? { billingAddress: patch.billingAddress } : {}),
        ...(patch.taxIdentifier !== undefined ? { taxIdentifier: patch.taxIdentifier } : {}),
        ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
        ...(patch.currency !== undefined ? { currency: patch.currency } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(customers.id, customerId), eq(customers.organizationId, organizationId)))
      .returning();
    if (!updated[0]) throw notFound('Customer');

    await this.audit.record({
      organizationId,
      actorUserId,
      action: 'customer.updated',
      entityType: 'customer',
      entityId: customerId,
      metadata: { fields: Object.keys(patch) },
      requestId: context?.requestId ?? null,
    });
    return updated[0]!;
  }

  async setArchived(
    organizationId: string,
    actorUserId: string,
    customerId: string,
    archived: boolean,
    context?: { requestId?: string | null },
  ): Promise<Customer> {
    await this.get(organizationId, customerId);
    const updated = await this.db
      .update(customers)
      .set({
        status: archived ? 'archived' : 'active',
        archivedAt: archived ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(and(eq(customers.id, customerId), eq(customers.organizationId, organizationId)))
      .returning();
    await this.audit.record({
      organizationId,
      actorUserId,
      action: archived ? 'customer.archived' : 'customer.restored',
      entityType: 'customer',
      entityId: customerId,
      requestId: context?.requestId ?? null,
    });
    return updated[0]!;
  }

  async setReminderOptOut(
    organizationId: string,
    customerId: string,
    optedOut: boolean,
  ): Promise<{ reminderOptOut: boolean }> {
    const rows = await this.db
      .update(customers)
      .set({ reminderOptOut: optedOut, updatedAt: new Date() })
      .where(and(eq(customers.id, customerId), eq(customers.organizationId, organizationId)))
      .returning({ optOut: customers.reminderOptOut });
    if (!rows[0]) throw notFound('Customer');
    return { reminderOptOut: rows[0].optOut };
  }

  async detail(organizationId: string, customerId: string) {
    const customer = await this.get(organizationId, customerId);

    const invoiceRows = await this.db
      .select({
        id: invoices.id,
        invoiceNumber: invoices.invoiceNumber,
        status: invoices.status,
        issueDate: invoices.issueDate,
        dueDate: invoices.dueDate,
        currency: invoices.currency,
        totalMinor: invoices.totalMinor,
        sentAt: invoices.sentAt,
      })
      .from(invoices)
      .where(and(eq(invoices.organizationId, organizationId), eq(invoices.customerId, customerId)))
      .orderBy(desc(invoices.issueDate))
      .limit(50);

    const allocationRows = await this.db
      .select({
        invoiceId: invoices.id,
        allocated: allocatedForInvoiceTable(organizationId),
      })
      .from(invoices)
      .where(
        and(eq(invoices.organizationId, organizationId), eq(invoices.customerId, customerId)),
      );

    const allocatedByInvoice = new Map(allocationRows.map((row) => [row.invoiceId, Number(row.allocated)]));

    const paymentRows = await this.db
      .select({
        id: payments.id,
        amountMinor: payments.amountMinor,
        currency: payments.currency,
        method: payments.method,
        status: payments.status,
        source: payments.source,
        paidAt: payments.paidAt,
        reference: payments.reference,
      })
      .from(payments)
      .where(and(eq(payments.organizationId, organizationId), eq(payments.customerId, customerId)))
      .orderBy(desc(payments.paidAt))
      .limit(50);

    const timeline = await this.audit.forEntity('customer', customerId, 25);

    const outstandingByCurrency = new Map<string, number>();
    for (const invoice of invoiceRows) {
      if (invoice.status === 'void') continue;
      const balance = Number(invoice.totalMinor) - (allocatedByInvoice.get(invoice.id) ?? 0);
      if (balance > 0) {
        outstandingByCurrency.set(
          invoice.currency,
          (outstandingByCurrency.get(invoice.currency) ?? 0) + balance,
        );
      }
    }

    return {
      customer,
      invoices: invoiceRows.map((invoice) => ({
        ...invoice,
        issueDate: toDateString(invoice.issueDate),
        dueDate: invoice.dueDate ? toDateString(invoice.dueDate) : null,
        paidMinor: allocatedByInvoice.get(invoice.id) ?? 0,
        balanceMinor:
          invoice.status === 'void'
            ? 0
            : Number(invoice.totalMinor) - (allocatedByInvoice.get(invoice.id) ?? 0),
      })),
      payments: paymentRows.map((payment) => ({
        ...payment,
        amountMinor: Number(payment.amountMinor),
        paidAt: toDateString(payment.paidAt),
      })),
      outstandingByCurrency: [...outstandingByCurrency.entries()].map(([currency, amountMinor]) => ({
        currency,
        amountMinor,
      })),
      timeline,
    };
  }

  /** Options for the invoice customer picker (active customers only). */
  async options(organizationId: string, q?: string, limit = 20) {
    const filters = [eq(customers.organizationId, organizationId), eq(customers.status, 'active')];
    if (q) {
      const needle = `%${q.replace(/[%_]/g, (match) => `\\${match}`)}%`;
      filters.push(or(ilike(customers.name, needle), ilike(customers.email, needle))!);
    }
    return this.db
      .select({
        id: customers.id,
        name: customers.name,
        email: customers.email,
        currency: customers.currency,
      })
      .from(customers)
      .where(and(...filters))
      .orderBy(asc(customers.name))
      .limit(Math.min(limit, 50));
  }
}

function toDateString(value: Date | string): string {
  if (typeof value === 'string') return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}