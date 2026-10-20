/**
 * CSV export (Part B / B3.8, B8).
 *
 * Exports are authorized by permission, rate limited at the route layer and
 * written to the audit log. Every cell is formula-injection escaped.
 */

import { and, asc, desc, eq, sql } from 'drizzle-orm';

import { formatMinorAsDecimal, toCsv } from '@collectflow/shared';

import type { AppDatabase } from '../db/client.js';
import { allocatedForInvoiceTable } from '../db/balance-sql.js';
import { customers, invoices, payments, reminderLogs } from '../db/schema.js';
import type { AuditService } from './audit.service.js';

export type ExportDataset = 'invoices' | 'customers' | 'payments' | 'aging' | 'reminders';

export class ExportService {
  constructor(
    private readonly db: AppDatabase,
    private readonly audit: AuditService,
  ) {}

  async build(
    organizationId: string,
    dataset: ExportDataset,
    actorUserId: string,
    context: { requestId?: string | null } = {},
  ): Promise<{ filename: string; csv: string; rowCount: number }> {
    const result = await this.render(organizationId, dataset);
    await this.audit.record({
      organizationId,
      actorUserId,
      action: 'export.generated',
      entityType: 'organization',
      entityId: organizationId,
      metadata: { dataset, rowCount: result.rowCount },
      requestId: context.requestId ?? null,
    });
    return result;
  }

  private async render(
    organizationId: string,
    dataset: ExportDataset,
  ): Promise<{ filename: string; csv: string; rowCount: number }> {
    const stamp = new Date().toISOString().slice(0, 10);
    switch (dataset) {
      case 'invoices':
        return this.invoices(organizationId, `collectflow-invoices-${stamp}.csv`);
      case 'customers':
        return this.customers(organizationId, `collectflow-customers-${stamp}.csv`);
      case 'payments':
        return this.paymentLedger(organizationId, `collectflow-payments-${stamp}.csv`);
      case 'aging':
        return this.aging(organizationId, `collectflow-aging-${stamp}.csv`);
      case 'reminders':
        return this.reminders(organizationId, `collectflow-reminders-${stamp}.csv`);
    }
  }

  private async invoices(organizationId: string, filename: string) {
    const rows = await this.db
      .select({
        invoiceNumber: invoices.invoiceNumber,
        customer: customers.name,
        status: invoices.status,
        issueDate: invoices.issueDate,
        dueDate: invoices.dueDate,
        currency: invoices.currency,
        subtotalMinor: invoices.subtotalMinor,
        discountMinor: invoices.discountMinor,
        taxMinor: invoices.taxMinor,
        totalMinor: invoices.totalMinor,
        allocated: allocatedForInvoiceTable(organizationId),
      })
      .from(invoices)
      .innerJoin(customers, eq(customers.id, invoices.customerId))
      .where(eq(invoices.organizationId, organizationId))
      .orderBy(asc(invoices.issueDate), asc(invoices.invoiceNumber));

    const body = rows.map((row) => {
      const total = Number(row.totalMinor);
      const allocated = Number(row.allocated);
      return [
        row.invoiceNumber,
        row.customer,
        row.status,
        toDate(row.issueDate),
        row.dueDate ? toDate(row.dueDate) : '',
        row.currency,
        formatMinorAsDecimal(Number(row.subtotalMinor), row.currency),
        formatMinorAsDecimal(Number(row.discountMinor), row.currency),
        formatMinorAsDecimal(Number(row.taxMinor), row.currency),
        formatMinorAsDecimal(total, row.currency),
        formatMinorAsDecimal(allocated, row.currency),
        formatMinorAsDecimal(row.status === 'void' ? 0 : total - allocated, row.currency),
      ];
    });

    return {
      filename,
      rowCount: rows.length,
      csv: toCsv(
        body,
        [
          'invoice_number',
          'customer',
          'status',
          'issue_date',
          'due_date',
          'currency',
          'subtotal',
          'discount',
          'tax',
          'total',
          'paid',
          'balance',
        ],
      ),
    };
  }

  private async customers(organizationId: string, filename: string) {
    const rows = await this.db
      .select({
        name: customers.name,
        legalName: customers.legalName,
        email: customers.email,
        phone: customers.phone,
        taxIdentifier: customers.taxIdentifier,
        currency: customers.currency,
        status: customers.status,
      })
      .from(customers)
      .where(eq(customers.organizationId, organizationId))
      .orderBy(asc(customers.name));

    return {
      filename,
      rowCount: rows.length,
      csv: toCsv(
        rows.map((row) => [
          row.name,
          row.legalName ?? '',
          row.email ?? '',
          row.phone ?? '',
          row.taxIdentifier ?? '',
          row.currency ?? '',
          row.status,
        ]),
        ['name', 'legal_name', 'email', 'phone', 'tax_identifier', 'preferred_currency', 'status'],
      ),
    };
  }

  private async paymentLedger(organizationId: string, filename: string) {
    const rows = await this.db
      .select({
        id: payments.id,
        customer: customers.name,
        amountMinor: payments.amountMinor,
        currency: payments.currency,
        method: payments.method,
        source: payments.source,
        status: payments.status,
        reference: payments.reference,
        paidAt: payments.paidAt,
      })
      .from(payments)
      .innerJoin(customers, eq(customers.id, payments.customerId))
      .where(eq(payments.organizationId, organizationId))
      .orderBy(desc(payments.paidAt));

    return {
      filename,
      rowCount: rows.length,
      csv: toCsv(
        rows.map((row) => [
          row.id,
          row.customer,
          formatMinorAsDecimal(Number(row.amountMinor), row.currency),
          row.currency,
          row.method,
          row.source,
          row.status,
          row.reference ?? '',
          toDate(row.paidAt),
        ]),
        [
          'payment_id',
          'customer',
          'amount',
          'currency',
          'method',
          'source',
          'status',
          'reference',
          'paid_at',
        ],
      ),
    };
  }

  private async aging(organizationId: string, filename: string) {
    const rows = await this.db
      .select({
        invoiceNumber: invoices.invoiceNumber,
        customer: customers.name,
        currency: invoices.currency,
        dueDate: invoices.dueDate,
        totalMinor: invoices.totalMinor,
        allocated: allocatedForInvoiceTable(organizationId),
      })
      .from(invoices)
      .innerJoin(customers, eq(customers.id, invoices.customerId))
      .where(
        and(eq(invoices.organizationId, organizationId), sql`${invoices.status} in ('sent','partially_paid')`),
      )
      .orderBy(asc(invoices.dueDate));

    const today = new Date().toISOString().slice(0, 10);
    return {
      filename,
      rowCount: rows.length,
      csv: toCsv(
        rows.map((row) => {
          const balance = Number(row.totalMinor) - Number(row.allocated);
          const due = row.dueDate ? toDate(row.dueDate) : '';
          const days = due ? Math.round((Date.parse(today) - Date.parse(due)) / 86_400_000) : 0;
          return [
            row.invoiceNumber,
            row.customer,
            row.currency,
            due,
            days > 0 ? `${days} days overdue` : 'Not yet due',
            formatMinorAsDecimal(balance, row.currency),
          ];
        }),
        ['invoice_number', 'customer', 'currency', 'due_date', 'ageing', 'balance'],
      ),
    };
  }

  private async reminders(organizationId: string, filename: string) {
    const rows = await this.db
      .select({
        id: reminderLogs.id,
        invoiceNumber: invoices.invoiceNumber,
        customer: customers.name,
        scheduledFor: reminderLogs.scheduledFor,
        sentAt: reminderLogs.sentAt,
        status: reminderLogs.status,
        failureCode: reminderLogs.failureCode,
      })
      .from(reminderLogs)
      .innerJoin(invoices, eq(invoices.id, reminderLogs.invoiceId))
      .innerJoin(customers, eq(customers.id, reminderLogs.customerId))
      .where(eq(reminderLogs.organizationId, organizationId))
      .orderBy(desc(reminderLogs.createdAt));

    return {
      filename,
      rowCount: rows.length,
      csv: toCsv(
        rows.map((row) => [
          row.id,
          row.invoiceNumber,
          row.customer,
          row.scheduledFor.toISOString(),
          row.sentAt?.toISOString() ?? '',
          row.status,
          row.failureCode ?? '',
        ]),
        ['id', 'invoice_number', 'customer', 'scheduled_for', 'sent_at', 'status', 'failure_code'],
      ),
    };
  }
}

function toDate(value: Date | string): string {
  if (typeof value === 'string') return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}