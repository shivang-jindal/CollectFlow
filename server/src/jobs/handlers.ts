/**
 * Job handlers (Part A / A2, Part B / B4).
 *
 * Every handler is idempotent and reports a retryable/non-retryable error so
 * the queue can distinguish a transient provider failure from a permanent
 * configuration problem. Nothing here claims an external action succeeded
 * unless the provider confirmed it.
 */

import { and, eq } from 'drizzle-orm';

import { daysBetweenIso } from '@collectflow/shared';

import type { Services } from '../container.js';
import { invoices, organizations, reminderLogs } from '../db/schema.js';
import { formatMoney, type TemplateContext } from '../integrations/email/templates.js';

export interface JobOutcome {
  retryable: boolean;
  code: string;
  message: string;
}

export type JobHandler = (
  services: Services,
  payload: Record<string, unknown>,
) => Promise<JobOutcome>;

const ok = (message: string): JobOutcome => ({ retryable: false, code: 'ok', message });

const handlers: Record<string, JobHandler> = {
  /** Deliver one queued email message. */
  'email.deliver': async (services, payload) => {
    const messageId = String(payload.messageId ?? '');
    if (!messageId) return { retryable: false, code: 'bad_payload', message: 'messageId is required' };

    const result = await services.email.deliver(messageId);
    if (result.status === 'sent') {
      const reminderLogId = payload.reminderLogId ? String(payload.reminderLogId) : null;
      if (reminderLogId) {
        await services.reminders.recordResult({
          reminderLogId,
          status: 'sent',
          providerMessageId: result.providerMessageId,
        });
      }
      return ok(result.message);
    }

    // A non-configured provider is permanent until an operator fixes it.
    const permanent = result.message.toLowerCase().includes('not configured');
    return {
      retryable: !permanent && result.retryable,
      code: permanent ? 'email_not_configured' : 'email_send_failed',
      message: result.message,
    };
  },

  /** Materialise due reminders and enqueue their emails. */
  'reminders.schedule': async (services, payload) => {
    const organizationId = payload.organizationId ? String(payload.organizationId) : null;
    if (!organizationId) return ok('No organization supplied; nothing to schedule.');

    const result = await services.reminders.scheduleDueReminders(organizationId);
    let queued = 0;

    for (const candidate of result.candidates) {
      const organization = (
        await services.db.select().from(organizations).where(eq(organizations.id, organizationId)).limit(1)
      )[0];
      const invoice = (
        await services.db
          .select()
          .from(invoices)
          .where(eq(invoices.id, candidate.invoiceId))
          .limit(1)
      )[0];
      if (!invoice) continue;

      const context: TemplateContext = {
        organizationName: organization?.name ?? 'Your business',
        customerName: candidate.customerName,
        invoiceNumber: candidate.invoiceNumber,
        issueDate: String(invoice.issueDate).slice(0, 10),
        dueDate: candidate.dueDate,
        totalFormatted: formatMoney(candidate.totalMinor, candidate.currency),
        balanceFormatted: formatMoney(candidate.balanceMinor, candidate.currency),
        publicUrl: null,
        daysUntilDue: daysBetweenIso(new Date().toISOString().slice(0, 10), candidate.dueDate),
        notes: invoice.notes,
      };

      const log = (
        await services.db
          .select({ id: reminderLogs.id })
          .from(reminderLogs)
          .where(eq(reminderLogs.idempotencyKey, `${organizationId}:${candidate.invoiceId}:${candidate.ruleId}:${candidate.targetDate}`))
          .limit(1)
      )[0];

      const message = await services.email.queueInvoiceEmail({
        organizationId,
        to: candidate.customerEmail,
        templateType: candidate.templateId,
        context,
        relatedInvoiceId: candidate.invoiceId,
        ...(log ? { reminderLogId: log.id } : {}),
        idempotencyKey: `reminder:${organizationId}:${candidate.invoiceId}:${candidate.ruleId}:${candidate.targetDate}`,
      });

      await services.jobs.enqueue({
        jobType: 'email.deliver',
        organizationId,
        payload: { messageId: message.messageId, ...(log ? { reminderLogId: log.id } : {}) },
        idempotencyKey: `email-deliver:${message.messageId}`,
      });
      queued += 1;
    }

    return ok(`Scheduled ${result.created} reminders and queued ${queued} emails.`);
  },

  /** Cancel queued reminders for invoices that are now paid or void. */
  'invoices.reconcile': async (services, payload) => {
    const organizationId = String(payload.organizationId ?? '');
    if (!organizationId) return ok('No organization supplied.');

    const settled = await services.db
      .select({ id: invoices.id })
      .from(invoices)
      .where(
        and(
          eq(invoices.organizationId, organizationId),
          eq(invoices.status, 'paid'),
        ),
      );

    let cancelled = 0;
    for (const invoice of settled) {
      cancelled += await services.reminders.cancelQueued(
        organizationId,
        invoice.id,
        'Invoice is already paid.',
      );
    }
    return ok(`Cancelled ${cancelled} pending reminders.`);
  },

  /** Housekeeping: drop revoked sessions and expired tokens. */
  'maintenance.cleanup': async (services) => {
    const cutoff = new Date(Date.now() - 30 * 24 * 3_600_000);
    await services.db.execute({
      text: 'delete from sessions where expires_at < now() or revoked_at is not null and revoked_at < $1',
      values: [cutoff],
    } as never);
    await services.db.execute({
      text: 'delete from password_reset_tokens where expires_at < now()',
      values: [],
    } as never);
    return ok('Cleanup complete.');
  },
};

export function resolveHandler(jobType: string): JobHandler | null {
  return handlers[jobType] ?? null;
}

export function knownJobTypes(): string[] {
  return Object.keys(handlers);
}