/** Domain constants shared by the CollectFlow server and client. */

export const PRODUCT_NAME = 'CollectFlow';

/** Roles (Part A / A5). */
export const ROLES = ['owner', 'admin', 'member', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
  viewer: 'Viewer',
};

/**
 * Permission flags (Part B / B2). `owner` and `admin` implicitly hold all
 * flags except `ownership.transfer` and `organization.delete`, which are
 * owner-only.
 */
export const PERMISSIONS = [
  'invoice.create',
  'invoice.edit',
  'invoice.send',
  'payment.record',
  'report.export',
  'settings.manage',
  'customer.manage',
  'integration.manage',
  'member.manage',
  'audit.view',
  'ownership.transfer',
  'organization.delete',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const VIEWER_PERMISSIONS: Permission[] = [];
const MEMBER_PERMISSIONS: Permission[] = [
  'invoice.create',
  'invoice.edit',
  'customer.manage',
  'report.export',
];
const ADMIN_PERMISSIONS: Permission[] = [
  ...MEMBER_PERMISSIONS,
  'invoice.send',
  'payment.record',
  'settings.manage',
  'integration.manage',
  'member.manage',
  'audit.view',
];

export function permissionsForRole(role: Role): Permission[] {
  switch (role) {
    case 'owner':
      return [...PERMISSIONS];
    case 'admin':
      return [...ADMIN_PERMISSIONS];
    case 'member':
      return [...MEMBER_PERMISSIONS];
    case 'viewer':
      return [...VIEWER_PERMISSIONS];
  }
}

export function roleHasPermission(role: Role, permission: Permission): boolean {
  return permissionsForRole(role).includes(permission);
}

/**
 * Stored invoice lifecycle status.
 *
 * `overdue` is intentionally NOT stored: it is a derived status computed from
 * `due_date` for any non-void invoice with an outstanding balance
 * (Part B / B3 - "store lifecycle status separately to avoid inconsistent state").
 */
export const INVOICE_STATUSES = ['draft', 'sent', 'partially_paid', 'paid', 'void'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

/** Derived display status, computed server-side and never persisted. */
export const INVOICE_DISPLAY_STATUSES = [
  'draft',
  'sent',
  'partially_paid',
  'paid',
  'overdue',
  'void',
] as const;
export type InvoiceDisplayStatus = (typeof INVOICE_DISPLAY_STATUSES)[number];

export function deriveDisplayStatus(
  status: InvoiceStatus,
  dueDate: string | null,
  balanceMinor: number,
  today: string,
): InvoiceDisplayStatus {
  if (status === 'void') return 'void';
  if (status === 'paid' || balanceMinor <= 0) return 'paid';
  if (dueDate && dueDate < today && (status === 'sent' || status === 'partially_paid')) {
    return 'overdue';
  }
  return status;
}

export const PAYMENT_METHODS = [
  'bank_transfer',
  'cash',
  'cheque',
  'card',
  'provider',
  'other',
] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_SOURCES = ['manual', 'provider'] as const;
export type PaymentSource = (typeof PAYMENT_SOURCES)[number];

export const PAYMENT_STATUSES = ['recorded', 'reversed', 'refunded', 'chargeback'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const PAYMENT_ADJUSTMENT_TYPES = ['refund', 'reversal', 'chargeback'] as const;
export type PaymentAdjustmentType = (typeof PAYMENT_ADJUSTMENT_TYPES)[number];

export const REMINDER_RULE_DIRECTIONS = ['before', 'on', 'after'] as const;
export type ReminderDirection = (typeof REMINDER_RULE_DIRECTIONS)[number];

export const REMINDER_LOG_STATUSES = [
  'queued',
  'sent',
  'delivered',
  'bounced',
  'failed',
  'skipped',
] as const;
export type ReminderLogStatus = (typeof REMINDER_LOG_STATUSES)[number];

export const INTEGRATION_PROVIDERS = ['email', 'payment'] as const;
export type IntegrationProviderKind = (typeof INTEGRATION_PROVIDERS)[number];

export const INTEGRATION_STATUSES = [
  'not_configured',
  'configured',
  'error',
  'disabled',
] as const;
export type IntegrationStatus = (typeof INTEGRATION_STATUSES)[number];

export const BACKGROUND_JOB_STATUSES = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
] as const;
export type BackgroundJobStatus = (typeof BACKGROUND_JOB_STATUSES)[number];

/** Job types actually registered in `server/src/jobs/handlers.ts`. */
export const BACKGROUND_JOB_TYPES = [
  'email.deliver',
  'reminders.schedule',
  'invoices.reconcile',
  'maintenance.cleanup',
] as const;
export type BackgroundJobType = (typeof BACKGROUND_JOB_TYPES)[number];

/** AR aging buckets (Part B / B3 reports). */
export const AGING_BUCKETS = ['current', '1_30', '31_60', '61_90', '90_plus'] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];

export const AGING_BUCKET_LABELS: Record<AgingBucket, string> = {
  current: 'Not yet due',
  '1_30': '1-30 days',
  '31_60': '31-60 days',
  '61_90': '61-90 days',
  '90_plus': '90+ days',
};

export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 25;