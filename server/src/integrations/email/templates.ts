/**
 * Email templates and rendering.
 *
 * Templates are plain text + simple HTML with an allow-listed placeholder set.
 * Everything interpolated is escaped: no user content can inject markup.
 */

import { escapeHtml } from '../../lib/util.js';
import { formatMinorAsDecimal } from '@collectflow/shared';

export interface TemplateContext {
  organizationName: string;
  customerName: string;
  invoiceNumber: string;
  issueDate: string;
  dueDate: string | null;
  totalFormatted: string;
  balanceFormatted: string;
  publicUrl: string | null;
  daysUntilDue: number | null;
  notes: string | null;
}

export const PLACEHOLDERS = [
  '{{organizationName}}',
  '{{customerName}}',
  '{{invoiceNumber}}',
  '{{issueDate}}',
  '{{dueDate}}',
  '{{total}}',
  '{{balance}}',
  '{{publicUrl}}',
  '{{daysUntilDue}}',
  '{{notes}}',
] as const;

export interface EmailTemplateDefinition {
  type: string;
  subject: string;
  bodyHtml: string;
}

const LAYOUT = (body: string) => `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f8fafc;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#0f172a;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;padding:24px;">
    ${body}
    <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0;" />
    <p style="font-size:12px;color:#64748b;margin:0;">
      Sent by CollectFlow on behalf of {{organizationName}}. CollectFlow is an invoicing tool, not a bank or
      payment processor. If you did not expect this message, contact {{organizationName}} directly.
    </p>
  </div>
</body></html>`;

export const DEFAULT_TEMPLATES: EmailTemplateDefinition[] = [
  {
    type: 'invoice_sent',
    subject: 'Invoice {{invoiceNumber}} from {{organizationName}}',
    bodyHtml: LAYOUT(`
      <h1 style="font-size:20px;margin:0 0 12px;">Invoice {{invoiceNumber}}</h1>
      <p style="margin:0 0 8px;">Hello {{customerName}},</p>
      <p style="margin:0 0 16px;">Please find invoice <strong>{{invoiceNumber}}</strong> issued on {{issueDate}}{{dueDate}}.
      The amount due is <strong>{{balance}}</strong>.</p>
      {{publicUrlBlock}}
      <p style="font-size:13px;color:#475569;margin:0;">{{notes}}</p>
    `),
  },
  {
    type: 'reminder_due_soon',
    subject: 'Invoice {{invoiceNumber}} is due on {{dueDate}}',
    bodyHtml: LAYOUT(`
      <h1 style="font-size:20px;margin:0 0 12px;">Friendly reminder</h1>
      <p style="margin:0 0 12px;">Hello {{customerName}},</p>
      <p style="margin:0 0 16px;">Invoice <strong>{{invoiceNumber}}</strong> is due on {{dueDate}}.
      The outstanding balance is <strong>{{balance}}</strong>.</p>
      {{publicUrlBlock}}
    `),
  },
  {
    type: 'reminder_due_today',
    subject: 'Invoice {{invoiceNumber}} is due today',
    bodyHtml: LAYOUT(`
      <h1 style="font-size:20px;margin:0 0 12px;">Due today</h1>
      <p style="margin:0 0 16px;">Hello {{customerName}}, invoice <strong>{{invoiceNumber}}</strong> is due today.
      The outstanding balance is <strong>{{balance}}</strong>.</p>
      {{publicUrlBlock}}
    `),
  },
  {
    type: 'reminder_overdue',
    subject: 'Invoice {{invoiceNumber}} is {{daysUntilDue}} days overdue',
    bodyHtml: LAYOUT(`
      <h1 style="font-size:20px;margin:0 0 12px;">Payment overdue</h1>
      <p style="margin:0 0 16px;">Hello {{customerName}}, invoice <strong>{{invoiceNumber}}</strong> is now
      {{daysUntilDue}} days past its due date of {{dueDate}}. The outstanding balance is <strong>{{balance}}</strong>.</p>
      {{publicUrlBlock}}
      <p style="font-size:13px;color:#475569;">If the payment is already on its way, please ignore this message.</p>
    `),
  },
];

const PUBLIC_BLOCK = `<p style="margin:0 0 16px;">
  <a href="{{publicUrl}}" style="display:inline-block;background:#0f172a;color:#ffffff;text-decoration:none;padding:10px 16px;border-radius:8px;font-size:14px;">View invoice</a>
</p>`;

const PUBLIC_BLOCK_DISABLED = `<p style="margin:0 0 16px;font-size:13px;color:#64748b;">
  A direct invoice link has not been published for this invoice. Please reply to this email if you need a copy.
</p>`;

/** Replace allow-listed placeholders. Unknown tokens are removed, not executed. */
export function renderTemplate(template: string, context: TemplateContext, isHtml: boolean): string {
  let output = template;
  output = output.replace(/\{\{publicUrlBlock\}\}/g, context.publicUrl ? PUBLIC_BLOCK : PUBLIC_BLOCK_DISABLED);

  const values: Record<string, string> = {
    organizationName: context.organizationName,
    customerName: context.customerName,
    invoiceNumber: context.invoiceNumber,
    issueDate: context.issueDate,
    dueDate: context.dueDate ?? 'on receipt',
    total: context.totalFormatted,
    balance: context.balanceFormatted,
    publicUrl: context.publicUrl ?? '',
    daysUntilDue: context.daysUntilDue === null ? '0' : String(context.daysUntilDue),
    notes: context.notes ?? '',
  };

  for (const key of Object.keys(values)) {
    const raw = values[key] ?? '';
    const safe = isHtml ? escapeHtml(raw) : raw.replace(/[\r\n]+/g, ' ');
    output = output.split(`{{${key}}}`).join(safe);
  }
  // Drop anything left that looks like a placeholder we do not support.
  return output.replace(/\{\{[a-zA-Z]+\}\}/g, '');
}

/** Plain-text alternative for the same context. */
export function renderPlainText(template: string, context: TemplateContext): string {
  const withBlock = template
    .replace(/\{\{publicUrlBlock\}\}/g, context.publicUrl ? `View the invoice: ${context.publicUrl}` : 'No online invoice link has been published for this invoice.')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '');
  return renderTemplate(withBlock, context, false)
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line, index, lines) => !(line === '' && lines[index - 1] === ''))
    .join('\n')
    .trim();
}

export function formatMoney(minor: number, currency: string): string {
  return `${formatMinorAsDecimal(minor, currency)} ${currency}`;
}