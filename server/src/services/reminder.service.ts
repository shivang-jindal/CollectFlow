/**
 * Reminders (Part B / B3.7, B7).
 *
 * - A reminder log row is created with a unique idempotency key of
 *   (invoice, rule, target date), so retries and duplicate scheduling can never
 *   send twice.
 * - Quiet hours and the organization timezone are applied to scheduling.
 * - Nothing is sent when the customer opted out, the invoice is paid/void, or
 *   reminders are globally paused.
 * - Delivery status is only ever what the provider reports.
 */

import { and, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';

import {
  addDaysIso,
  minutesSinceMidnightInZone,
  todayIso,
  type Paginated,
} from '@collectflow/shared';

import type { AppDatabase } from '../db/client.js';
import { allocatedForInvoiceTable, effectiveAllocatedSql } from '../db/balance-sql.js';
import {
  customers,
  invoices,
  organizationSettings,
  organizations,
  reminderLogs,
  reminderRules,
} from '../db/schema.js';
import { formatMinorAsDecimal } from '@collectflow/shared';
import type { JobQueue } from '../jobs/queue.js';
import type { AuditService } from './audit.service.js';

export interface ReminderLogRow {
  id: string;
  organizationId: string;
  invoiceId: string;
  customerId: string;
  ruleId: string | null;
  scheduledFor: string;
  sentAt: string | null;
  providerMessageId: string | null;
  status: string;
  failureCode: string | null;
  safeFailureMessage: string | null;
  attemptCount: number;
  idempotencyKey: string;
  subject: string | null;
  createdAt: string;
}

export interface ReminderCandidate {
  invoiceId: string;
  invoiceNumber: string;
  customerId: string;
  customerName: string;
  customerEmail: string;
  currency: string;
  totalMinor: number;
  balanceMinor: number;
  dueDate: string;
  targetDate: string;
  ruleId: string;
  ruleName: string;
  templateId: string;
}

export class ReminderService {
  constructor(
    private readonly db: AppDatabase,
    private readonly jobs: JobQueue,
    private readonly audit: AuditService,
  ) {}

  /**
   * Materialise due reminders into the outbox.
   *
   * Idempotent: running it twice creates nothing new because
   * `reminder_logs.idempotency_key` is unique.
   */
  async scheduleDueReminders(organizationId: string, options: { runAfter?: Date } = {}): Promise<{
    created: number;
    skipped: number;
    candidates: ReminderCandidate[];
  }> {
    const organization = (
      await this.db.select().from(organizations).where(eq(organizations.id, organizationId)).limit(1)
    )[0];
    if (!organization) return { created: 0, skipped: 0, candidates: [] };

    const settings = (
      await this.db
        .select()
        .from(organizationSettings)
        .where(eq(organizationSettings.organizationId, organizationId))
        .limit(1)
    )[0];
    if (settings?.remindersPaused) return { created: 0, skipped: 0, candidates: [] };

    const rules = await this.db
      .select()
      .from(reminderRules)
      .where(and(eq(reminderRules.organizationId, organizationId), eq(reminderRules.enabled, true)));
    if (rules.length === 0) return { created: 0, skipped: 0, candidates: [] };

    const today = todayIso(organization.timezone);
    const horizon = addDaysIso(today, 60);

    const openInvoices = await this.db
      .select({
        invoiceId: invoices.id,
        invoiceNumber: invoices.invoiceNumber,
        status: invoices.status,
        dueDate: invoices.dueDate,
        totalMinor: invoices.totalMinor,
        currency: invoices.currency,
        customerId: customers.id,
        customerName: customers.name,
        customerEmail: customers.email,
        reminderOptOut: customers.reminderOptOut,
        allocated: allocatedForInvoiceTable(organizationId),
      })
      .from(invoices)
      .innerJoin(customers, eq(customers.id, invoices.customerId))
      .where(
        and(
          eq(invoices.organizationId, organizationId),
          inArray(invoices.status, ['sent', 'partially_paid']),
        ),
      );

    let created = 0;
    let skipped = 0;
    const candidates: ReminderCandidate[] = [];

    for (const invoice of openInvoices) {
      const balance = Number(invoice.totalMinor) - Number(invoice.allocated);
      if (balance <= 0) continue;
      if (invoice.reminderOptOut) {
        skipped += 1;
        continue;
      }
      if (!invoice.customerEmail) {
        skipped += 1;
        continue;
      }
      if (!invoice.dueDate) continue;
      const dueDate = toDate(invoice.dueDate);

      for (const rule of rules) {
        const targetDate = addDaysIso(dueDate, rule.offsetDays);
        if (targetDate > horizon) continue;
        if (targetDate < today) {
          // A past window is not sent retroactively beyond 3 days of grace.
          if (addDaysIso(targetDate, 3) < today) continue;
        }

        const idempotencyKey = `${organizationId}:${invoice.invoiceId}:${rule.id}:${targetDate}`;
        const existing = await this.db
          .select({ id: reminderLogs.id, status: reminderLogs.status })
          .from(reminderLogs)
          .where(eq(reminderLogs.idempotencyKey, idempotencyKey))
          .limit(1);
        if (existing[0]) {
          skipped += 1;
          continue;
        }

        const runAfter = this.resolveSendTime(
          options.runAfter ?? new Date(),
          targetDate,
          organization.timezone,
          settings?.quietHoursStart ?? null,
          settings?.quietHoursEnd ?? null,
        );

        const inserted = await this.db
          .insert(reminderLogs)
          .values({
            organizationId,
            invoiceId: invoice.invoiceId,
            customerId: invoice.customerId,
            ruleId: rule.id,
            scheduledFor: runAfter,
            status: 'queued',
            idempotencyKey,
          })
          .onConflictDoNothing({ target: reminderLogs.idempotencyKey })
          .returning({ id: reminderLogs.id });

        if (!inserted[0]) {
          skipped += 1;
          continue;
        }
        created += 1;
        candidates.push({
          invoiceId: invoice.invoiceId,
          invoiceNumber: invoice.invoiceNumber,
          customerId: invoice.customerId,
          customerName: invoice.customerName,
          customerEmail: invoice.customerEmail!,
          currency: invoice.currency,
          totalMinor: Number(invoice.totalMinor),
          balanceMinor: balance,
          dueDate,
          targetDate,
          ruleId: rule.id,
          ruleName: rule.name,
          templateId: rule.templateId,
        });
      }
    }

    return { created, skipped, candidates };
  }

  /**
   * Turn a local wall-clock target time into an instant, deferring into quiet
   * hours when the send would land inside them.
   */
  private resolveSendTime(
    now: Date,
    targetDate: string,
    timezone: string,
    quietStart: string | null,
    quietEnd: string | null,
  ): Date {
    const target = new Date(`${targetDate}T09:00:00.000Z`);
    if (target <= now) return now;

    if (!quietStart || !quietEnd) return target;

    const startMinutes = toMinutes(quietStart);
    const endMinutes = toMinutes(quietEnd);
    const targetMinutes = minutesSinceMidnightInZone(target, timezone);
    const inside =
      startMinutes <= endMinutes
        ? targetMinutes >= startMinutes && targetMinutes < endMinutes
        : targetMinutes >= startMinutes || targetMinutes < endMinutes;
    if (!inside) return target;

    // Move to the end of the quiet window on the following day.
    const hoursAfter = endMinutes >= startMinutes ? endMinutes - targetMinutes : 24 * 60 - targetMinutes + endMinutes;
    return new Date(target.getTime() + hoursAfter * 60_000);
  }

  async listLogs(
    organizationId: string,
    query: {
      page: number;
      pageSize: number;
      invoiceId?: string;
      status?: string;
      from?: string;
      to?: string;
    },
  ): Promise<Paginated<ReminderLogRow>> {
    const filters = [eq(reminderLogs.organizationId, organizationId)];
    if (query.invoiceId) filters.push(eq(reminderLogs.invoiceId, query.invoiceId));
    if (query.status && query.status !== 'all') filters.push(eq(reminderLogs.status, query.status));
    if (query.from) filters.push(gte(reminderLogs.createdAt, new Date(`${query.from}T00:00:00.000Z`)));
    if (query.to) filters.push(lte(reminderLogs.createdAt, new Date(`${query.to}T23:59:59.999Z`)));

    const where = and(...filters);
    const rows = await this.db
      .select()
      .from(reminderLogs)
      .where(where)
      .orderBy(desc(reminderLogs.createdAt))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize);
    const countRows = await this.db
      .select({ total: sql<number>`count(*)::int` })
      .from(reminderLogs)
      .where(where);
    const total = countRows[0]?.total ?? 0;

    return {
      items: rows.map((row) => ({
        ...row,
        scheduledFor: row.scheduledFor.toISOString(),
        sentAt: row.sentAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
      })),
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
    };
  }

  /** Marks every queued reminder for an invoice as skipped (invoice paid/void). */
  async cancelQueued(organizationId: string, invoiceId: string, reason: string) {
    const updated = await this.db
      .update(reminderLogs)
      .set({ status: 'skipped', safeFailureMessage: reason })
      .where(
        and(
          eq(reminderLogs.organizationId, organizationId),
          eq(reminderLogs.invoiceId, invoiceId),
          eq(reminderLogs.status, 'queued'),
        ),
      )
      .returning({ id: reminderLogs.id });
    return updated.length;
  }

  async preview(organizationId: string, invoiceId: string) {
    const invoice = (
      await this.db
        .select()
        .from(invoices)
        .where(and(eq(invoices.id, invoiceId), eq(invoices.organizationId, organizationId)))
        .limit(1)
    )[0];
    if (!invoice) return null;
    const customer = (
      await this.db
        .select()
        .from(customers)
        .where(eq(customers.id, invoice.customerId))
        .limit(1)
    )[0];
    const rules = await this.db
      .select()
      .from(reminderRules)
      .where(eq(reminderRules.organizationId, organizationId));

    const balance =
      Number(invoice.totalMinor) -
      Number(
        (
          await this.db
            .select({ amount: effectiveAllocatedSql(sql`${invoiceId}`, sql`${organizationId}`) })
            .from(invoices)
            .where(eq(invoices.id, invoiceId))
        )[0]?.amount ?? 0,
      );

    return {
      invoiceNumber: invoice.invoiceNumber,
      customerName: customer?.name ?? 'Customer',
      customerEmail: customer?.email ?? null,
      dueDate: invoice.dueDate ? toDate(invoice.dueDate) : null,
      balanceMinor: balance,
      balanceFormatted: `${formatMinorAsDecimal(balance, invoice.currency)} ${invoice.currency}`,
      reminderOptOut: customer?.reminderOptOut ?? false,
      rules: rules.map((rule) => ({
        id: rule.id,
        name: rule.name,
        enabled: rule.enabled,
        offsetDays: rule.offsetDays,
        direction: rule.direction,
        targetDate: invoice.dueDate
          ? addDaysIso(toDate(invoice.dueDate), rule.offsetDays)
          : null,
      })),
    };
  }

  async recordResult(input: {
    reminderLogId: string;
    status: 'sent' | 'failed' | 'skipped';
    providerMessageId?: string | null;
    failureCode?: string | null;
    failureMessage?: string | null;
  }) {
    await this.db
      .update(reminderLogs)
      .set({
        status: input.status,
        sentAt: input.status === 'sent' ? new Date() : null,
        providerMessageId: input.providerMessageId ?? null,
        failureCode: input.failureCode ?? null,
        safeFailureMessage: input.failureMessage?.slice(0, 300) ?? null,
        attemptCount: sql`${reminderLogs.attemptCount} + 1`,
      })
      .where(eq(reminderLogs.id, input.reminderLogId));
  }
}

function toDate(value: Date | string): string {
  if (typeof value === 'string') return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}

function toMinutes(value: string): number {
  const [hours = '0', minutes = '0'] = value.split(':');
  return Number(hours) * 60 + Number(minutes);
}