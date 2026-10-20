/**
 * CollectFlow database schema (Part B / B5).
 *
 * - UUID primary keys, `timestamptz` UTC timestamps.
 * - Every tenant-owned table carries `organization_id` and is indexed on it.
 * - Money is stored as `bigint` minor units (integer cents/paise).
 */

import { relations, sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const now = sql`now()`;

export const organizations = pgTable(
  'organizations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    countryCode: text('country_code').notNull().default('US'),
    timezone: text('timezone').notNull().default('UTC'),
    baseCurrency: text('base_currency').notNull().default('USD'),
    logoUrl: text('logo_url'),
    /** Legal/billing address block used on invoices and PDFs. */
    addressLine1: text('address_line1'),
    addressLine2: text('address_line2'),
    city: text('city'),
    region: text('region'),
    postalCode: text('postal_code'),
    taxIdentifier: text('tax_identifier'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(now),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [uniqueIndex('organizations_slug_idx').on(table.slug)],
);

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    passwordHash: text('password_hash'),
    displayName: text('display_name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(now),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
  },
  (table) => [uniqueIndex('users_email_idx').on(table.email)],
);

export const memberships = pgTable(
  'memberships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    status: text('status').notNull().default('active'),
    invitedBy: uuid('invited_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(now),
  },
  (table) => [
    uniqueIndex('memberships_org_user_idx').on(table.organizationId, table.userId),
    index('memberships_user_idx').on(table.userId),
  ],
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** SHA-256 of the opaque session token. The token itself is never stored. */
    tokenHash: text('token_hash').notNull(),
    activeOrganizationId: uuid('active_organization_id').references(() => organizations.id, {
      onDelete: 'set null',
    }),
    userAgent: text('user_agent'),
    ipAddress: text('ip_address'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('sessions_token_hash_idx').on(table.tokenHash),
    index('sessions_user_idx').on(table.userId),
  ],
);

export const invitations = pgTable(
  'invitations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    role: text('role').notNull(),
    /** SHA-256 of the single-use invite token. */
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    invitedBy: uuid('invited_by')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
  },
  (table) => [
    uniqueIndex('invitations_token_hash_idx').on(table.tokenHash),
    index('invitations_org_idx').on(table.organizationId),
  ],
);

export const passwordResetTokens = pgTable(
  'password_reset_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
  },
  (table) => [uniqueIndex('password_reset_token_hash_idx').on(table.tokenHash)],
);

export const organizationSettings = pgTable('organization_settings', {
  organizationId: uuid('organization_id')
    .primaryKey()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  invoicePrefix: text('invoice_prefix').notNull().default('INV-'),
  nextNumber: bigint('next_number', { mode: 'number' }).notNull().default(1),
  defaultTerms: text('default_terms'),
  defaultPaymentInstructions: text('default_payment_instructions'),
  defaultNotes: text('default_notes'),
  defaultDueDays: integer('default_due_days').notNull().default(14),
  taxLabel: text('tax_label').notNull().default('Tax'),
  taxRateBasisPoints: integer('tax_rate_basis_points').notNull().default(0),
  allowManualPayments: boolean('allow_manual_payments').notNull().default(true),
  allowIssueDateAfterDueDate: boolean('allow_issue_date_after_due_date').notNull().default(false),
  quietHoursStart: text('quiet_hours_start'),
  quietHoursEnd: text('quiet_hours_end'),
  remindersPaused: boolean('reminders_paused').notNull().default(true),
  /** Per-customer reminder opt-out. */
  reminderOptOut: boolean('reminder_opt_out').notNull().default(false),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(now),
});

export const customers = pgTable(
  'customers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    legalName: text('legal_name'),
    email: text('email'),
    phone: text('phone'),
    billingAddress: jsonb('billing_address_json').$type<CustomerAddress | null>(),
    taxIdentifier: text('tax_identifier'),
    notes: text('notes'),
    currency: text('currency'),
    status: text('status').notNull().default('active'),
    reminderOptOut: boolean('reminder_opt_out').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(now),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (table) => [
    index('customers_org_status_idx').on(table.organizationId, table.status),
    index('customers_org_name_idx').on(table.organizationId, table.name),
  ],
);

export interface CustomerAddress {
  line1?: string;
  line2?: string;
  city?: string;
  region?: string;
  postalCode?: string;
  countryCode?: string;
}

export const invoiceSequences = pgTable('invoice_sequences', {
  organizationId: uuid('organization_id')
    .primaryKey()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  prefix: text('prefix').notNull().default('INV-'),
  nextNumber: bigint('next_number', { mode: 'number' }).notNull().default(1),
});

export const invoices = pgTable(
  'invoices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'restrict' }),
    invoiceNumber: text('invoice_number').notNull(),
    status: text('status').notNull().default('draft'),
    issueDate: date('issue_date').notNull(),
    dueDate: date('due_date'),
    currency: text('currency').notNull(),
    subtotalMinor: bigint('subtotal_minor', { mode: 'number' }).notNull().default(0),
    discountMinor: bigint('discount_minor', { mode: 'number' }).notNull().default(0),
    taxMinor: bigint('tax_minor', { mode: 'number' }).notNull().default(0),
    totalMinor: bigint('total_minor', { mode: 'number' }).notNull().default(0),
    notes: text('notes'),
    terms: text('terms'),
    paymentInstructions: text('payment_instructions'),
    taxLabel: text('tax_label'),
    /** SHA-256 of the unguessable public-view token. The token is shown once. */
    publicTokenHash: text('public_token_hash'),
    publicTokenRevokedAt: timestamp('public_token_revoked_at', { withTimezone: true }),
    publicLinkCreatedAt: timestamp('public_link_created_at', { withTimezone: true }),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidReason: text('void_reason'),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    version: integer('version').notNull().default(1),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(now),
  },
  (table) => [
    // Prevents duplicate invoice numbers even under simultaneous requests.
    uniqueIndex('invoices_org_number_idx').on(table.organizationId, table.invoiceNumber),
    index('invoices_org_status_idx').on(table.organizationId, table.status),
    index('invoices_org_issue_date_idx').on(table.organizationId, table.issueDate),
    index('invoices_org_due_date_idx').on(table.organizationId, table.dueDate),
    index('invoices_customer_idx').on(table.customerId),
    index('invoices_public_token_idx').on(table.publicTokenHash),
  ],
);

export const invoiceItems = pgTable(
  'invoice_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'cascade' }),
    description: text('description').notNull(),
    quantity: text('quantity').notNull().default('1'),
    unitPriceMinor: bigint('unit_price_minor', { mode: 'number' }).notNull(),
    discountMinor: bigint('discount_minor', { mode: 'number' }).notNull().default(0),
    taxRateBasisPoints: integer('tax_rate_basis_points').notNull().default(0),
    lineTotalMinor: bigint('line_total_minor', { mode: 'number' }).notNull().default(0),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
  },
  (table) => [index('invoice_items_invoice_idx').on(table.invoiceId, table.sortOrder)],
);

export const invoiceRevisions = pgTable(
  'invoice_revisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    snapshot: jsonb('snapshot_json').$type<Record<string, unknown>>().notNull(),
    changedBy: uuid('changed_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
  },
  (table) => [uniqueIndex('invoice_revisions_invoice_version_idx').on(table.invoiceId, table.version)],
);

/**
 * Append-only ledger. A payment row is never edited or deleted; corrections are
 * represented by `payment_adjustments` rows (Part B / B3.6).
 */
export const payments = pgTable(
  'payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'restrict' }),
    amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
    currency: text('currency').notNull(),
    method: text('method').notNull(),
    source: text('source').notNull().default('manual'),
    providerName: text('provider_name'),
    providerTransactionId: text('provider_transaction_id'),
    reference: text('reference'),
    paidAt: date('paid_at').notNull(),
    status: text('status').notNull().default('recorded'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
  },
  (table) => [
    index('payments_org_paid_at_idx').on(table.organizationId, table.paidAt),
    index('payments_org_customer_idx').on(table.organizationId, table.customerId),
    uniqueIndex('payments_provider_txn_idx')
      .on(table.organizationId, table.providerName, table.providerTransactionId)
      .where(sql`${table.source} = 'provider'`),
  ],
);

export const paymentAllocations = pgTable(
  'payment_allocations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    paymentId: uuid('payment_id')
      .notNull()
      .references(() => payments.id, { onDelete: 'cascade' }),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'restrict' }),
    amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
  },
  (table) => [
    index('payment_allocations_payment_idx').on(table.paymentId),
    index('payment_allocations_invoice_idx').on(table.invoiceId),
  ],
);

export const paymentAdjustments = pgTable(
  'payment_adjustments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    paymentId: uuid('payment_id')
      .notNull()
      .references(() => payments.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
    reason: text('reason').notNull(),
    externalReference: text('external_reference'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
  },
  (table) => [index('payment_adjustments_payment_idx').on(table.paymentId)],
);

export const reminderRules = pgTable(
  'reminder_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    offsetDays: integer('offset_days').notNull(),
    direction: text('direction').notNull(),
    enabled: boolean('enabled').notNull().default(false),
    quietHours: jsonb('quiet_hours_json').$type<{ start: string; end: string } | null>(),
    templateId: text('template_id').notNull().default('reminder_due_soon'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(now),
  },
  (table) => [index('reminder_rules_org_idx').on(table.organizationId, table.enabled)],
);

export const reminderLogs = pgTable(
  'reminder_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    ruleId: uuid('rule_id').references(() => reminderRules.id, { onDelete: 'set null' }),
    scheduledFor: timestamp('scheduled_for', { withTimezone: true }).notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    providerMessageId: text('provider_message_id'),
    status: text('status').notNull().default('queued'),
    failureCode: text('failure_code'),
    safeFailureMessage: text('safe_failure_message'),
    attemptCount: integer('attempt_count').notNull().default(0),
    /** Dedupes (invoice, rule, target date) so retries never double-send. */
    idempotencyKey: text('idempotency_key').notNull(),
    subject: text('subject'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
  },
  (table) => [
    uniqueIndex('reminder_logs_idempotency_idx').on(table.idempotencyKey),
    index('reminder_logs_org_status_idx').on(table.organizationId, table.status),
    index('reminder_logs_invoice_idx').on(table.invoiceId),
  ],
);

export const emailTemplates = pgTable(
  'email_templates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    subject: text('subject').notNull(),
    bodyHtml: text('body_html').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(now),
  },
  (table) => [
    uniqueIndex('email_templates_org_type_idx').on(table.organizationId, table.type),
  ],
);

export const emailMessages = pgTable(
  'email_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Nullable: password-reset mail is sent before any organization exists. */
    organizationId: uuid('organization_id').references(() => organizations.id, {
      onDelete: 'cascade',
    }),
    templateType: text('template_type').notNull(),
    toAddress: text('to_address').notNull(),
    fromAddress: text('from_address').notNull(),
    subject: text('subject').notNull(),
    /** Plain-text alternative; never store raw secrets. */
    bodyText: text('body_text'),
    status: text('status').notNull().default('queued'),
    providerMessageId: text('provider_message_id'),
    failureCode: text('failure_code'),
    safeFailureMessage: text('safe_failure_message'),
    relatedInvoiceId: uuid('related_invoice_id'),
    reminderLogId: uuid('reminder_log_id'),
    idempotencyKey: text('idempotency_key'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
  },
  (table) => [
    index('email_messages_org_status_idx').on(table.organizationId, table.status),
    uniqueIndex('email_messages_idempotency_idx')
      .on(table.idempotencyKey)
      .where(sql`${table.idempotencyKey} is not null`),
  ],
);

export const integrations = pgTable(
  'integrations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    status: text('status').notNull().default('not_configured'),
    /** AES-256-GCM envelope; the plaintext key never leaves the server. */
    encryptedCredentials: text('encrypted_credentials_json'),
    enabled: boolean('enabled').notNull().default(true),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    lastErrorCode: text('last_error_code'),
    lastErrorMessage: text('last_error_message'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(now),
  },
  (table) => [uniqueIndex('integrations_org_provider_idx').on(table.organizationId, table.provider)],
);

export const webhookEvents = pgTable(
  'webhook_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    provider: text('provider').notNull(),
    providerEventId: text('provider_event_id').notNull(),
    organizationId: uuid('organization_id').references(() => organizations.id, {
      onDelete: 'cascade',
    }),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().default(now),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    status: text('status').notNull().default('received'),
    payloadHash: text('payload_hash').notNull(),
    errorCode: text('error_code'),
  },
  (table) => [uniqueIndex('webhook_events_provider_event_idx').on(table.provider, table.providerEventId)],
);

export const auditEvents = pgTable(
  'audit_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id'),
    /** Redacted metadata only - never credentials or personal data. */
    metadata: jsonb('metadata_json').$type<Record<string, unknown>>(),
    requestId: text('request_id'),
    ipAddress: text('ip_address'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
  },
  (table) => [
    index('audit_events_org_created_idx').on(table.organizationId, table.createdAt),
    index('audit_events_entity_idx').on(table.entityType, table.entityId),
  ],
);

export const backgroundJobs = pgTable(
  'background_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').references(() => organizations.id, {
      onDelete: 'cascade',
    }),
    jobType: text('job_type').notNull(),
    payload: jsonb('payload_json').$type<Record<string, unknown>>().notNull().default({}),
    status: text('status').notNull().default('queued'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    runAfter: timestamp('run_after', { withTimezone: true }).notNull().default(now),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    lockedBy: text('locked_by'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    lastErrorCode: text('last_error_code'),
    lastErrorMessage: text('last_error_message'),
    idempotencyKey: text('idempotency_key'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
  },
  (table) => [
    index('background_jobs_claim_idx').on(table.status, table.runAfter),
    index('background_jobs_org_idx').on(table.organizationId, table.createdAt),
    uniqueIndex('background_jobs_idempotency_idx')
      .on(table.idempotencyKey)
      .where(sql`${table.idempotencyKey} is not null`),
  ],
);

/* -------------------------------------------------------------------------- */
/* Relations                                                                  */
/* -------------------------------------------------------------------------- */

export const organizationsRelations = relations(organizations, ({ many }) => ({
  memberships: many(memberships),
  customers: many(customers),
  invoices: many(invoices),
  settings: many(organizationSettings),
}));

export const membershipsRelations = relations(memberships, ({ one }) => ({
  organization: one(organizations, {
    fields: [memberships.organizationId],
    references: [organizations.id],
  }),
  user: one(users, { fields: [memberships.userId], references: [users.id] }),
}));

export const customersRelations = relations(customers, ({ many, one }) => ({
  organization: one(organizations, {
    fields: [customers.organizationId],
    references: [organizations.id],
  }),
  invoices: many(invoices),
  payments: many(payments),
}));

export const invoicesRelations = relations(invoices, ({ many, one }) => ({
  organization: one(organizations, {
    fields: [invoices.organizationId],
    references: [organizations.id],
  }),
  customer: one(customers, { fields: [invoices.customerId], references: [customers.id] }),
  items: many(invoiceItems),
  allocations: many(paymentAllocations),
  revisions: many(invoiceRevisions),
}));

export const paymentsRelations = relations(payments, ({ many, one }) => ({
  customer: one(customers, { fields: [payments.customerId], references: [customers.id] }),
  allocations: many(paymentAllocations),
  adjustments: many(paymentAdjustments),
}));

export const paymentAllocationsRelations = relations(paymentAllocations, ({ one }) => ({
  payment: one(payments, { fields: [paymentAllocations.paymentId], references: [payments.id] }),
  invoice: one(invoices, {
    fields: [paymentAllocations.invoiceId],
    references: [invoices.id],
  }),
}));

export const invoiceItemsRelations = relations(invoiceItems, ({ one }) => ({
  invoice: one(invoices, { fields: [invoiceItems.invoiceId], references: [invoices.id] }),
}));

export type Organization = typeof organizations.$inferSelect;
export type User = typeof users.$inferSelect;
export type Membership = typeof memberships.$inferSelect;
export type Customer = typeof customers.$inferSelect;
export type Invoice = typeof invoices.$inferSelect;
export type InvoiceItem = typeof invoiceItems.$inferSelect;
export type Payment = typeof payments.$inferSelect;
export type PaymentAllocation = typeof paymentAllocations.$inferSelect;
export type ReminderRule = typeof reminderRules.$inferSelect;
export type ReminderLog = typeof reminderLogs.$inferSelect;
export type Integration = typeof integrations.$inferSelect;
export type AuditEvent = typeof auditEvents.$inferSelect;
export type BackgroundJob = typeof backgroundJobs.$inferSelect;
export type OrganizationSettings = typeof organizationSettings.$inferSelect;
export type EmailTemplate = typeof emailTemplates.$inferSelect;
export type EmailMessage = typeof emailMessages.$inferSelect;