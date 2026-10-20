/**
 * Invoices (Part B / B3.2 - B3.4, B4, B7).
 *
 * Rules enforced here, never in the browser:
 *  - Totals are always recalculated server-side from the persisted line items.
 *  - The invoice number comes from a transactionally incremented sequence, so
 *    simultaneous requests cannot collide (unique index is the final guard).
 *  - Financial edits are only allowed while an invoice is a draft. A sent
 *    invoice must be voided and reissued; every revision is snapshotted.
 *  - `overdue` is derived, never stored.
 */

import { and, asc, count, desc, eq, gte, ilike, inArray, lte, or, sql } from 'drizzle-orm';

import {
  calculateInvoiceTotals,
  deriveDisplayStatus,
  formatMinorAsDecimal,
  todayIso,
  type InvoiceDisplayStatus,
  type InvoiceStatus,
  type Paginated,
} from '@collectflow/shared';

import type { AppDatabase } from '../db/client.js';
import { allocatedForInvoiceTable, effectiveAllocatedSql } from '../db/balance-sql.js';
import {
  customers,
  invoiceItems,
  invoiceRevisions,
  invoiceSequences,
  invoices,
  organizationSettings,
  paymentAdjustments,
  paymentAllocations,
  payments,
  type Invoice,
} from '../db/schema.js';
import { conflict, notFound, unprocessable } from '../errors.js';
import { randomToken, sha256Hex } from '../lib/crypto.js';
import type { AuditService } from './audit.service.js';

export interface InvoiceItemInput {
  description: string;
  quantity: string;
  unitPriceMinor: number;
  discountMinor?: number | null;
  taxRateBasisPoints?: number | null;
  sortOrder?: number | null;
}

export interface InvoiceInput {
  customerId: string;
  issueDate: string;
  dueDate?: string | null;
  currency: string;
  items: InvoiceItemInput[];
  discountMinor?: number;
  notes?: string | null;
  terms?: string | null;
  paymentInstructions?: string | null;
  saveAsDraft?: boolean;
}

export interface InvoiceListQuery {
  page: number;
  pageSize: number;
  q?: string;
  status: 'all' | 'draft' | 'sent' | 'partially_paid' | 'paid' | 'overdue' | 'void';
  customerId?: string;
  issueFrom?: string;
  issueTo?: string;
  dueFrom?: string;
  dueTo?: string;
  currency?: string;
  sort: 'invoice_number' | 'issue_date' | 'due_date' | 'total_minor' | 'balance_minor' | 'updated_at';
  order: 'asc' | 'desc';
}

type Tx = Parameters<Parameters<AppDatabase['transaction']>[0]>[0];

export class InvoiceService {
  constructor(
    private readonly db: AppDatabase,
    private readonly audit: AuditService,
  ) {}

  /* ---------------------------------------------------------------------- */
  /* Reads                                                                  */
  /* ---------------------------------------------------------------------- */

  async list(organizationId: string, timezone: string, query: InvoiceListQuery): Promise<Paginated<InvoiceListItemRow>> {
    const today = todayIso(timezone);
    const filters = [eq(invoices.organizationId, organizationId)];

    if (query.status === 'draft') filters.push(eq(invoices.status, 'draft'));
    if (query.status === 'void') filters.push(eq(invoices.status, 'void'));
    if (query.status === 'paid') filters.push(eq(invoices.status, 'paid'));
    if (query.status === 'sent') {
      filters.push(eq(invoices.status, 'sent'));
      filters.push(or(sql`${invoices.dueDate} is null`, gte(invoices.dueDate, today))!);
    }
    if (query.status === 'partially_paid') filters.push(eq(invoices.status, 'partially_paid'));
    if (query.status === 'overdue') {
      filters.push(inArray(invoices.status, ['sent', 'partially_paid']));
      filters.push(sql`${invoices.dueDate} is not null and ${invoices.dueDate} < ${today}`);
    }
    if (query.customerId) filters.push(eq(invoices.customerId, query.customerId));
    if (query.currency) filters.push(eq(invoices.currency, query.currency));
    if (query.issueFrom) filters.push(gte(invoices.issueDate, query.issueFrom));
    if (query.issueTo) filters.push(lte(invoices.issueDate, query.issueTo));
    if (query.dueFrom) filters.push(gte(invoices.dueDate, query.dueFrom));
    if (query.dueTo) filters.push(lte(invoices.dueDate, query.dueTo));
    if (query.q) {
      const needle = `%${query.q.replace(/[%_]/g, (match) => `\\${match}`)}%`;
      filters.push(
        or(
          ilike(invoices.invoiceNumber, needle),
          ilike(invoices.notes, needle),
          ilike(customers.name, needle),
          ilike(customers.email, needle),
        )!,
      );
    }

    const where = and(...filters);
    const allocatedExpr = allocatedForInvoiceTable(organizationId);
    const balanceExpr = sql<number>`(${invoices.totalMinor} - coalesce(${allocatedExpr}, 0))::bigint`;

    const orderColumn =
      query.sort === 'invoice_number'
        ? invoices.invoiceNumber
        : query.sort === 'due_date'
          ? invoices.dueDate
          : query.sort === 'total_minor'
            ? invoices.totalMinor
            : query.sort === 'balance_minor'
              ? balanceExpr
              : query.sort === 'updated_at'
                ? invoices.updatedAt
                : invoices.issueDate;

    const rows = await this.db
      .select({
        id: invoices.id,
        invoiceNumber: invoices.invoiceNumber,
        customerId: invoices.customerId,
        customerName: customers.name,
        status: invoices.status,
        issueDate: invoices.issueDate,
        dueDate: invoices.dueDate,
        currency: invoices.currency,
        subtotalMinor: invoices.subtotalMinor,
        discountMinor: invoices.discountMinor,
        taxMinor: invoices.taxMinor,
        totalMinor: invoices.totalMinor,
        sentAt: invoices.sentAt,
        paidAt: invoices.paidAt,
        voidedAt: invoices.voidedAt,
        updatedAt: invoices.updatedAt,
        allocated: sql<number>`coalesce(${allocatedExpr}, 0)::bigint`,
      })
      .from(invoices)
      .innerJoin(customers, eq(customers.id, invoices.customerId))
      .where(where)
      .orderBy(query.order === 'asc' ? asc(orderColumn) : desc(orderColumn))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize);

    const countRows = await this.db
      .select({ total: count() })
      .from(invoices)
      .innerJoin(customers, eq(customers.id, invoices.customerId))
      .where(where);
    const totalCount = countRows[0]?.total ?? 0;

    return {
      items: rows.map((row) => {
        const allocated = Number(row.allocated);
        const totalMinor = Number(row.totalMinor);
        const balance = row.status === 'void' ? 0 : totalMinor - allocated;
        return {
          id: row.id,
          invoiceNumber: row.invoiceNumber,
          customerId: row.customerId,
          customerName: row.customerName,
          status: row.status as InvoiceStatus,
          displayStatus: deriveDisplayStatus(
            row.status as InvoiceStatus,
            row.dueDate ? toDateString(row.dueDate) : null,
            balance,
            today,
          ),
          issueDate: toDateString(row.issueDate),
          dueDate: row.dueDate ? toDateString(row.dueDate) : null,
          currency: row.currency,
          subtotalMinor: Number(row.subtotalMinor),
          discountMinor: Number(row.discountMinor),
          taxMinor: Number(row.taxMinor),
          totalMinor,
          paidMinor: allocated,
          balanceMinor: balance,
          sentAt: row.sentAt?.toISOString() ?? null,
          paidAt: row.paidAt?.toISOString() ?? null,
          voidedAt: row.voidedAt?.toISOString() ?? null,
          updatedAt: row.updatedAt.toISOString(),
        } satisfies InvoiceListItemRow;
      }),
      page: query.page,
      pageSize: query.pageSize,
      total: totalCount,
      totalPages: Math.max(1, Math.ceil(totalCount / query.pageSize)),
    };
  }

  async get(organizationId: string, invoiceId: string): Promise<Invoice> {
    const rows = await this.db
      .select()
      .from(invoices)
      .where(and(eq(invoices.id, invoiceId), eq(invoices.organizationId, organizationId)))
      .limit(1);
    const row = rows[0];
    if (!row) throw notFound('Invoice');
    return row;
  }

  async detail(organizationId: string, invoiceId: string, timezone: string) {
    const invoice = await this.get(organizationId, invoiceId);
    const customer = await this.db
      .select()
      .from(customers)
      .where(and(eq(customers.id, invoice.customerId), eq(customers.organizationId, organizationId)))
      .limit(1);

    const items = await this.db
      .select()
      .from(invoiceItems)
      .where(eq(invoiceItems.invoiceId, invoiceId))
      .orderBy(invoiceItems.sortOrder);

    const allocations = await this.db
      .select({
        id: paymentAllocations.id,
        amountMinor: paymentAllocations.amountMinor,
        paymentId: paymentAllocations.paymentId,
        createdAt: paymentAllocations.createdAt,
        paymentMethod: payments.method,
        paymentSource: payments.source,
        paymentStatus: payments.status,
        paymentReference: payments.reference,
        paidAt: payments.paidAt,
      })
      .from(paymentAllocations)
      .innerJoin(payments, eq(payments.id, paymentAllocations.paymentId))
      .where(eq(paymentAllocations.invoiceId, invoiceId))
      .orderBy(asc(paymentAllocations.createdAt));

    const adjustments = await this.db
      .select({
        id: paymentAdjustments.id,
        paymentId: paymentAdjustments.paymentId,
        type: paymentAdjustments.type,
        amountMinor: paymentAdjustments.amountMinor,
        reason: paymentAdjustments.reason,
        createdAt: paymentAdjustments.createdAt,
      })
      .from(paymentAdjustments)
      .innerJoin(payments, eq(payments.id, paymentAdjustments.paymentId))
      .where(eq(paymentAdjustments.organizationId, organizationId))
      .orderBy(asc(paymentAdjustments.createdAt));

    const today = todayIso(timezone);
    // Use the SAME effective-allocation figure as the list, dashboard, reports
    // and public page, so a partially reversed payment can never make the
    // detail page disagree with the rest of the product.
    const effective = await this.db
      .select({ amount: effectiveAllocatedSql(sql`${invoiceId}`, sql`${organizationId}`) })
      .from(invoices)
      .where(eq(invoices.id, invoiceId));
    const paidMinor = Number(effective[0]?.amount ?? 0);
    const balanceMinor = invoice.status === 'void' ? 0 : Number(invoice.totalMinor) - paidMinor;

    return {
      invoice: {
        ...invoice,
        subtotalMinor: Number(invoice.subtotalMinor),
        discountMinor: Number(invoice.discountMinor),
        taxMinor: Number(invoice.taxMinor),
        totalMinor: Number(invoice.totalMinor),
        issueDate: toDateString(invoice.issueDate),
        dueDate: invoice.dueDate ? toDateString(invoice.dueDate) : null,
        sentAt: invoice.sentAt?.toISOString() ?? null,
        voidedAt: invoice.voidedAt?.toISOString() ?? null,
        paidAt: invoice.paidAt?.toISOString() ?? null,
        publicLinkActive: Boolean(invoice.publicTokenHash) && !invoice.publicTokenRevokedAt,
        createdAt: invoice.createdAt.toISOString(),
        updatedAt: invoice.updatedAt.toISOString(),
        displayStatus: deriveDisplayStatus(
          invoice.status as InvoiceStatus,
          invoice.dueDate ? toDateString(invoice.dueDate) : null,
          balanceMinor,
          today,
        ),
      },
      customer: customer[0] ?? null,
      items: items.map((item) => ({
        ...item,
        unitPriceMinor: Number(item.unitPriceMinor),
        discountMinor: Number(item.discountMinor),
        lineTotalMinor: Number(item.lineTotalMinor),
      })),
      allocations: allocations.map((row) => ({
        ...row,
        amountMinor: Number(row.amountMinor),
        createdAt: row.createdAt.toISOString(),
        paidAt: toDateString(row.paidAt),
      })),
      adjustments: adjustments.map((row) => ({
        ...row,
        amountMinor: Number(row.amountMinor),
        createdAt: row.createdAt.toISOString(),
      })),
      paidMinor,
      balanceMinor,
      timeline: await this.audit.forEntity('invoice', invoiceId, 100),
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Writes                                                                 */
  /* ---------------------------------------------------------------------- */

  async create(
    organizationId: string,
    actorUserId: string,
    input: InvoiceInput,
    options: { timezone: string; requestId?: string | null; sendImmediately?: boolean },
  ): Promise<Invoice> {
    await this.assertCustomerUsable(organizationId, input.customerId);

    const totals = calculateInvoiceTotals(
      input.items.map((item, index) => ({
        description: item.description,
        quantity: item.quantity,
        unitPriceMinor: item.unitPriceMinor,
        discountMinor: item.discountMinor ?? 0,
        taxRateBasisPoints: item.taxRateBasisPoints ?? 0,
        sortOrder: item.sortOrder ?? index,
      })),
      input.discountMinor ?? 0,
    );

    const asDraft = input.saveAsDraft !== false;

    // The organization tax label is snapshotted onto the invoice so a later
    // settings change never rewrites the document a customer already received.
    const orgSettings = (
      await this.db
        .select({ taxLabel: organizationSettings.taxLabel })
        .from(organizationSettings)
        .where(eq(organizationSettings.organizationId, organizationId))
        .limit(1)
    )[0];

    const invoice = await this.db.transaction(async (tx) => {
      const invoiceNumber = await allocateInvoiceNumber(tx, organizationId);
      const inserted = await tx
        .insert(invoices)
        .values({
          organizationId,
          customerId: input.customerId,
          invoiceNumber,
          status: asDraft ? 'draft' : 'sent',
          issueDate: input.issueDate,
          dueDate: input.dueDate ?? null,
          currency: input.currency,
          subtotalMinor: totals.subtotalMinor,
          discountMinor: totals.discountMinor,
          taxMinor: totals.taxMinor,
          totalMinor: totals.totalMinor,
          notes: input.notes ?? null,
          terms: input.terms ?? null,
          paymentInstructions: input.paymentInstructions ?? null,
          taxLabel: orgSettings?.taxLabel ?? 'Tax',
          createdBy: actorUserId,
          sentAt: asDraft ? null : new Date(),
          version: 1,
        })
        .returning();

      const created = inserted[0]!;
      await tx.insert(invoiceItems).values(
        totals.lines.map((line, index) => ({
          organizationId,
          invoiceId: created.id,
          description: line.description,
          quantity: line.quantity,
          unitPriceMinor: line.unitPriceMinor,
          discountMinor: line.discountMinor + line.allocatedInvoiceDiscountMinor,
          taxRateBasisPoints: line.taxRateBasisPoints,
          lineTotalMinor: line.lineTotalMinor,
          sortOrder: index,
        })),
      );
      await tx.insert(invoiceRevisions).values({
        organizationId,
        invoiceId: created.id,
        version: 1,
        snapshot: buildSnapshot(created, totals.lines),
        changedBy: actorUserId,
        reason: 'created',
      });
      return created;
    });

    await this.audit.record({
      organizationId,
      actorUserId,
      action: asDraft ? 'invoice.created' : 'invoice.created_and_sent',
      entityType: 'invoice',
      entityId: invoice.id,
      metadata: { invoiceNumber: invoice.invoiceNumber, totalMinor: Number(invoice.totalMinor) },
      requestId: options.requestId ?? null,
    });
    return invoice;
  }

  async update(
    organizationId: string,
    actorUserId: string,
    invoiceId: string,
    patch: Partial<InvoiceInput> & { reason?: string },
    options: { requestId?: string | null },
  ): Promise<Invoice> {
    const existing = await this.get(organizationId, invoiceId);
    if (existing.status === 'void') {
      throw unprocessable('A voided invoice cannot be edited. Create a new invoice instead.');
    }
    if (existing.status !== 'draft') {
      throw unprocessable(
        'A sent invoice cannot be edited because it may already have been paid. Void it and issue a corrected invoice; the original stays in the audit trail.',
      );
    }

    const items = patch.items
      ? patch.items
      : (
          await this.db
            .select()
            .from(invoiceItems)
            .where(eq(invoiceItems.invoiceId, invoiceId))
            .orderBy(invoiceItems.sortOrder)
        ).map((item) => ({
          description: item.description,
          quantity: item.quantity,
          unitPriceMinor: Number(item.unitPriceMinor),
          discountMinor: Number(item.discountMinor),
          taxRateBasisPoints: item.taxRateBasisPoints,
          sortOrder: item.sortOrder,
        }));

    const discountMinor = patch.discountMinor ?? Number(existing.discountMinor);
    const totals = calculateInvoiceTotals(items, discountMinor);

    if (patch.customerId) await this.assertCustomerUsable(organizationId, patch.customerId);

    const updated = await this.db.transaction(async (tx) => {
      const rows = await tx
        .update(invoices)
        .set({
          ...(patch.customerId ? { customerId: patch.customerId } : {}),
          ...(patch.issueDate ? { issueDate: patch.issueDate } : {}),
          ...(patch.dueDate !== undefined ? { dueDate: patch.dueDate } : {}),
          ...(patch.currency ? { currency: patch.currency } : {}),
          subtotalMinor: totals.subtotalMinor,
          discountMinor: totals.discountMinor,
          taxMinor: totals.taxMinor,
          totalMinor: totals.totalMinor,
          ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
          ...(patch.terms !== undefined ? { terms: patch.terms } : {}),
          ...(patch.paymentInstructions !== undefined
            ? { paymentInstructions: patch.paymentInstructions }
            : {}),
          version: Number(existing.version) + 1,
          updatedAt: new Date(),
        })
        .where(eq(invoices.id, invoiceId))
        .returning();

      await tx.delete(invoiceItems).where(eq(invoiceItems.invoiceId, invoiceId));
      await tx.insert(invoiceItems).values(
        totals.lines.map((line, index) => ({
          organizationId,
          invoiceId,
          description: line.description,
          quantity: line.quantity,
          unitPriceMinor: line.unitPriceMinor,
          discountMinor: line.discountMinor + line.allocatedInvoiceDiscountMinor,
          taxRateBasisPoints: line.taxRateBasisPoints,
          lineTotalMinor: line.lineTotalMinor,
          sortOrder: index,
        })),
      );

      const snapshot = buildSnapshot(rows[0]!, totals.lines);
      await tx.insert(invoiceRevisions).values({
        organizationId,
        invoiceId,
        version: Number(rows[0]!.version),
        snapshot,
        changedBy: actorUserId,
        reason: patch.reason ?? 'edited',
      });
      return rows[0]!;
    });

    await this.audit.record({
      organizationId,
      actorUserId,
      action: 'invoice.updated',
      entityType: 'invoice',
      entityId: invoiceId,
      metadata: { version: Number(updated.version), fields: Object.keys(patch) },
      requestId: options.requestId ?? null,
    });
    return updated;
  }

  /**
   * Moves a draft to `sent`, issues an unguessable public-view token and returns
   * it exactly once so the operator can copy a safe link.
   */
  async markSent(
    organizationId: string,
    actorUserId: string,
    invoiceId: string,
    options: { requestId?: string | null; rotatePublicLink?: boolean },
  ): Promise<{ invoice: Invoice; publicToken: string | null }> {
    const invoice = await this.get(organizationId, invoiceId);
    if (invoice.status === 'void') throw unprocessable('A voided invoice cannot be sent.');
    if (invoice.status === 'paid' || invoice.status === 'partially_paid') {
      throw unprocessable('This invoice already has recorded payments.');
    }
    if (!invoice.sentAt && invoice.dueDate && toDateString(invoice.dueDate) < toDateString(invoice.issueDate)) {
      throw unprocessable(
        'The due date is before the issue date. Fix the dates in the settings or on the draft before sending.',
      );
    }

    const needsToken = options.rotatePublicLink || !invoice.publicTokenHash;
    const token = needsToken ? randomToken(32) : null;

    const updated = await this.db
      .update(invoices)
      .set({
        status: invoice.status === 'draft' ? 'sent' : invoice.status,
        sentAt: invoice.sentAt ?? new Date(),
        ...(token
          ? {
              publicTokenHash: sha256Hex(token),
              publicTokenRevokedAt: null,
              publicLinkCreatedAt: new Date(),
            }
          : {}),
        version: Number(invoice.version) + 1,
        updatedAt: new Date(),
      })
      .where(eq(invoices.id, invoiceId))
      .returning();

    await this.audit.record({
      organizationId,
      actorUserId,
      action: invoice.sentAt ? 'invoice.resent' : 'invoice.sent',
      entityType: 'invoice',
      entityId: invoiceId,
      metadata: { invoiceNumber: invoice.invoiceNumber, publicLinkRotated: Boolean(options.rotatePublicLink) },
      requestId: options.requestId ?? null,
    });
    return { invoice: updated[0]!, publicToken: token };
  }

  async revokePublicLink(organizationId: string, actorUserId: string, invoiceId: string) {
    const updated = await this.db
      .update(invoices)
      .set({ publicTokenRevokedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(invoices.id, invoiceId), eq(invoices.organizationId, organizationId)))
      .returning({ id: invoices.id });
    if (!updated[0]) throw notFound('Invoice');
    await this.audit.record({
      organizationId,
      actorUserId,
      action: 'invoice.public_link_revoked',
      entityType: 'invoice',
      entityId: invoiceId,
    });
  }

  async duplicate(
    organizationId: string,
    actorUserId: string,
    invoiceId: string,
    options: { issueDate?: string; dueDate?: string | null; requestId?: string | null },
  ): Promise<Invoice> {
    const source = await this.get(organizationId, invoiceId);
    const items = await this.db
      .select()
      .from(invoiceItems)
      .where(eq(invoiceItems.invoiceId, invoiceId))
      .orderBy(invoiceItems.sortOrder);

    return this.create(
      organizationId,
      actorUserId,
      {
        customerId: source.customerId,
        issueDate: options.issueDate ?? toDateString(source.issueDate),
        dueDate: options.dueDate === undefined ? (source.dueDate ? toDateString(source.dueDate) : null) : options.dueDate,
        currency: source.currency,
        items: items.map((item) => ({
          description: item.description,
          quantity: item.quantity,
          unitPriceMinor: Number(item.unitPriceMinor),
          discountMinor: Number(item.discountMinor),
          taxRateBasisPoints: item.taxRateBasisPoints,
          sortOrder: item.sortOrder,
        })),
        discountMinor: Number(source.discountMinor),
        notes: source.notes,
        terms: source.terms,
        paymentInstructions: source.paymentInstructions,
        saveAsDraft: true,
      },
      { timezone: 'UTC', requestId: options.requestId ?? null },
    );
  }

  async voidInvoice(
    organizationId: string,
    actorUserId: string,
    invoiceId: string,
    reason: string,
    options: { requestId?: string | null },
  ): Promise<Invoice> {
    const invoice = await this.get(organizationId, invoiceId);
    if (invoice.status === 'void') throw unprocessable('This invoice is already voided.');

    const allocated = await this.db
      .select({ amount: sql<number>`coalesce(sum(${paymentAllocations.amountMinor}), 0)::bigint` })
      .from(paymentAllocations)
      .where(eq(paymentAllocations.invoiceId, invoiceId));
    const paidMinor = Number(allocated[0]?.amount ?? 0);
    if (paidMinor > 0) {
      throw unprocessable(
        'This invoice has recorded payments. Reverse or refund the payment first; payment records are never erased.',
      );
    }

    const updated = await this.db
      .update(invoices)
      .set({
        status: 'void',
        voidedAt: new Date(),
        voidReason: reason,
        publicTokenRevokedAt: new Date(),
        version: Number(invoice.version) + 1,
        updatedAt: new Date(),
      })
      .where(eq(invoices.id, invoiceId))
      .returning();

    await this.audit.record({
      organizationId,
      actorUserId,
      action: 'invoice.voided',
      entityType: 'invoice',
      entityId: invoiceId,
      metadata: { reason, invoiceNumber: invoice.invoiceNumber },
      requestId: options.requestId ?? null,
    });
    return updated[0]!;
  }

  async assertCustomerUsable(organizationId: string, customerId: string): Promise<void> {
    const rows = await this.db
      .select({ id: customers.id, status: customers.status })
      .from(customers)
      .where(and(eq(customers.id, customerId), eq(customers.organizationId, organizationId)))
      .limit(1);
    const row = rows[0];
    if (!row) throw notFound('Customer');
    if (row.status === 'archived') {
      throw unprocessable('This customer is archived. Restore the customer before invoicing them.');
    }
  }

  /** Used by the payment service after allocations change. */
  async recomputeStatus(
    tx: Tx,
    organizationId: string,
    invoiceId: string,
  ): Promise<{ status: InvoiceStatus; balanceMinor: number }> {
    const rows = await tx
      .select()
      .from(invoices)
      .where(and(eq(invoices.id, invoiceId), eq(invoices.organizationId, organizationId)))
      .limit(1);
    const invoice = rows[0];
    if (!invoice) throw notFound('Invoice');

    const allocated = await tx
      .select({ amount: effectiveAllocatedSql(sql`${invoiceId}`, sql`${organizationId}`) })
      .from(invoices)
      .where(eq(invoices.id, invoiceId));
    const paidMinor = Number(allocated[0]?.amount ?? 0);
    const balance = Number(invoice.totalMinor) - paidMinor;

    let status = invoice.status as InvoiceStatus;
    if (status !== 'void') {
      if (balance <= 0) status = 'paid';
      else if (paidMinor > 0) status = 'partially_paid';
      else status = 'sent';
    }

    const updated = await tx
      .update(invoices)
      .set({
        status,
        paidAt: status === 'paid' ? (invoice.paidAt ?? new Date()) : null,
        updatedAt: new Date(),
      })
      .where(eq(invoices.id, invoiceId))
      .returning({ status: invoices.status });

    return { status: (updated[0]?.status ?? status) as InvoiceStatus, balanceMinor: balance };
  }

  async findByPublicToken(token: string): Promise<Invoice | null> {
    const rows = await this.db
      .select()
      .from(invoices)
      .where(
        and(
          eq(invoices.publicTokenHash, sha256Hex(token)),
          sql`${invoices.publicTokenRevokedAt} is null`,
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }
}

export interface InvoiceListItemRow {
  id: string;
  invoiceNumber: string;
  customerId: string;
  customerName: string;
  status: InvoiceStatus;
  displayStatus: InvoiceDisplayStatus;
  issueDate: string;
  dueDate: string | null;
  currency: string;
  subtotalMinor: number;
  discountMinor: number;
  taxMinor: number;
  totalMinor: number;
  paidMinor: number;
  balanceMinor: number;
  sentAt: string | null;
  paidAt: string | null;
  voidedAt: string | null;
  updatedAt: string;
}

/**
 * Allocate the next invoice number atomically.
 *
 * `UPDATE ... RETURNING` takes a row lock, so two concurrent requests get two
 * different numbers. The `(organization_id, invoice_number)` unique index is the
 * final safety net.
 */
async function allocateInvoiceNumber(tx: Tx, organizationId: string): Promise<string> {
  const rows = await tx.execute<{ next_number: number }>(sql`
    UPDATE invoice_sequences
       SET next_number = next_number + 1
     WHERE organization_id = ${organizationId}
    RETURNING next_number - 1 AS next_number
  `);
  const allocated = rows.rows[0]?.next_number;
  if (allocated === undefined) {
    throw conflict('This organization has no invoice number sequence. Restore it in Settings.');
  }

  const prefixRows = await tx
    .select({ prefix: invoiceSequences.prefix })
    .from(invoiceSequences)
    .where(eq(invoiceSequences.organizationId, organizationId))
    .limit(1);
  const prefix = prefixRows[0]?.prefix ?? 'INV-';
  const width = Math.max(4, String(allocated).length);
  return `${prefix}${String(allocated).padStart(width, '0')}`;
}



function buildSnapshot(
  invoice: { invoiceNumber: string; issueDate: unknown; dueDate: unknown; currency: string; notes: string | null; terms: string | null },
  lines: Array<{
    description: string;
    quantity: string;
    unitPriceMinor: number;
    discountMinor: number;
    taxRateBasisPoints: number;
    lineTotalMinor: number;
  }>,
) {
  const totals = calculateInvoiceTotals(
    lines.map((line) => ({
      description: line.description,
      quantity: line.quantity,
      unitPriceMinor: line.unitPriceMinor,
      discountMinor: line.discountMinor,
      taxRateBasisPoints: line.taxRateBasisPoints,
    })),
    0,
  );
  return {
    invoiceNumber: invoice.invoiceNumber,
    issueDate: toDateString(invoice.issueDate as Date),
    dueDate: invoice.dueDate ? toDateString(invoice.dueDate as Date) : null,
    currency: invoice.currency,
    notes: invoice.notes,
    terms: invoice.terms,
    lines,
    totals: {
      subtotalMinor: totals.subtotalMinor,
      discountMinor: totals.discountMinor,
      taxMinor: totals.taxMinor,
      totalMinor: totals.totalMinor,
      formattedTotal: `${formatMinorAsDecimal(totals.totalMinor, invoice.currency)} ${invoice.currency}`,
    },
  };
}

function toDateString(value: Date | string): string {
  if (typeof value === 'string') return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}