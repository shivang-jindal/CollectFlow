/**
 * Zod schemas shared between the browser and the API.
 *
 * The server always re-validates with these schemas; the client uses them for
 * inline validation. Nothing here trusts the browser (Part A / A4).
 */

import { z } from 'zod';

import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, PAYMENT_METHODS, ROLES } from './constants.js';
import { SUPPORTED_CURRENCIES } from './money.js';

const uuid = z.string().uuid();
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected an ISO date (YYYY-MM-DD)');
const currency = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, 'Expected a 3-letter ISO 4217 currency code')
  .refine((code) => SUPPORTED_CURRENCIES.includes(code), {
    message: 'Unsupported currency',
  });
const money = z.number().int('Amounts must be whole minor units (e.g. cents)');

export const idSchema = uuid;
export const emailSchema = z.string().trim().toLowerCase().email('Enter a valid email address');
export const passwordSchema = z
  .string()
  .min(10, 'Use at least 10 characters')
  .max(200, 'Password is too long');

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});

export const idParamSchema = z.object({ id: uuid });

/* -------------------------------------------------------------------------- */
/* Auth                                                                       */
/* -------------------------------------------------------------------------- */

export const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  displayName: z.string().trim().min(1, 'Enter your name').max(120),
});

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Enter your password').max(200),
});

export const forgotPasswordSchema = z.object({
  email: emailSchema,
  organizationId: uuid.optional(),
});

export const resetPasswordSchema = z.object({
  token: z.string().min(20).max(400),
  password: passwordSchema,
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Enter your current password'),
  newPassword: passwordSchema,
});

export const updateProfileSchema = z.object({
  displayName: z.string().trim().min(1).max(120).optional(),
});

/* -------------------------------------------------------------------------- */
/* Organizations                                                              */
/* -------------------------------------------------------------------------- */

const countryCode = z
  .string()
  .trim()
  .toUpperCase()
  .length(2, 'Use a 2-letter country code');

export const createOrganizationSchema = z.object({
  name: z.string().trim().min(2, 'Enter an organization name').max(120),
  countryCode,
  timezone: z.string().trim().min(1).max(64),
  baseCurrency: currency,
});

export const updateOrganizationSchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    countryCode: countryCode.optional(),
    timezone: z.string().trim().min(1).max(64).optional(),
    logoUrl: z.string().url().max(500).nullable().optional(),
    addressLine1: z.string().trim().max(200).nullable().optional(),
    addressLine2: z.string().trim().max(200).nullable().optional(),
    city: z.string().trim().max(120).nullable().optional(),
    region: z.string().trim().max(120).nullable().optional(),
    postalCode: z.string().trim().max(24).nullable().optional(),
    taxIdentifier: z.string().trim().max(64).nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Provide at least one field to update',
  });

export const transferOwnershipSchema = z.object({
  membershipId: uuid,
  confirmation: z.literal('TRANSFER OWNERSHIP'),
});

export const createInvitationSchema = z.object({
  email: emailSchema,
  role: z.enum(ROLES).refine((role) => role !== 'owner', {
    message: 'Ownership is transferred separately',
  }),
});

export const changeMemberRoleSchema = z.object({ role: z.enum(ROLES) });

export const acceptInvitationSchema = z.object({ token: z.string().min(20).max(400) });

/* -------------------------------------------------------------------------- */
/* Settings                                                                   */
/* -------------------------------------------------------------------------- */

export const updateInvoiceSettingsSchema = z.object({
  invoicePrefix: z
    .string()
    .trim()
    .max(12)
    .regex(/^[A-Za-z0-9-]*$/, 'Use letters, numbers and dashes only')
    .optional(),
  nextNumber: z.number().int().min(1).max(999_999_999).optional(),
  defaultTerms: z.string().trim().max(2000).nullable().optional(),
  defaultPaymentInstructions: z.string().trim().max(2000).nullable().optional(),
  defaultNotes: z.string().trim().max(2000).nullable().optional(),
  defaultDueDays: z.number().int().min(0).max(365).optional(),
  taxLabel: z.string().trim().max(32).optional(),
  taxRateBasisPoints: z.number().int().min(0).max(10_000).optional(),
  allowManualPayments: z.boolean().optional(),
  allowIssueDateAfterDueDate: z.boolean().optional(),
  quietHoursStart: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM')
    .nullable()
    .optional(),
  quietHoursEnd: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM').nullable().optional(),
  remindersPaused: z.boolean().optional(),
});

export const updateReminderRulesSchema = z.object({
  rules: z
    .array(
      z.object({
        id: uuid,
        name: z.string().trim().min(1).max(80),
        offsetDays: z.number().int().min(-365).max(365),
        direction: z.enum(['before', 'on', 'after']),
        enabled: z.boolean(),
        templateId: z.string().trim().min(1).max(64),
      }),
    )
    .max(50),
});

/* -------------------------------------------------------------------------- */
/* Customers                                                                  */
/* -------------------------------------------------------------------------- */

const addressSchema = z
  .object({
    line1: z.string().trim().max(200).optional(),
    line2: z.string().trim().max(200).optional(),
    city: z.string().trim().max(120).optional(),
    region: z.string().trim().max(120).optional(),
    postalCode: z.string().trim().max(24).optional(),
    countryCode: countryCode.optional(),
  })
  .strict();

export const createCustomerSchema = z.object({
  name: z.string().trim().min(1, 'Enter a name').max(160),
  legalName: z.string().trim().max(160).nullable().optional(),
  email: emailSchema.nullable().optional(),
  phone: z
    .string()
    .trim()
    .regex(/^\+?[0-9 ()-]{4,32}$/, 'Enter a valid phone number')
    .nullable()
    .optional(),
  billingAddress: addressSchema.nullable().optional(),
  taxIdentifier: z.string().trim().max(64).nullable().optional(),
  notes: z.string().trim().max(4000).nullable().optional(),
  currency: currency.nullable().optional(),
});

export const updateCustomerSchema = createCustomerSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Provide at least one field to update',
  });

export const customerListQuerySchema = paginationSchema.extend({
  q: z.string().trim().max(120).optional(),
  status: z.enum(['active', 'archived', 'all']).default('active'),
  currency: currency.optional(),
  sort: z.enum(['name', 'created_at', 'outstanding']).default('name'),
  order: z.enum(['asc', 'desc']).default('asc'),
});

/* -------------------------------------------------------------------------- */
/* Invoices                                                                   */
/* -------------------------------------------------------------------------- */

export const invoiceItemInputSchema = z
  .object({
    description: z.string().trim().min(1, 'Describe the line item').max(500),
    quantity: z
      .string()
      .trim()
      .regex(/^\d+(\.\d{1,4})?$/, 'Use a positive quantity with up to 4 decimals'),
    unitPriceMinor: money.nonnegative('Amounts cannot be negative'),
    discountMinor: money.nonnegative().optional(),
    taxRateBasisPoints: z.number().int().min(0).max(10_000).optional(),
    sortOrder: z.number().int().min(0).max(1000).optional(),
  })
  .strict();

export const createInvoiceSchema = z
  .object({
    customerId: uuid,
    issueDate: isoDate,
    dueDate: isoDate.nullable().optional(),
    currency: currency,
    items: z.array(invoiceItemInputSchema).min(1, 'Add at least one line item').max(100),
    discountMinor: money.nonnegative().default(0),
    notes: z.string().trim().max(4000).nullable().optional(),
    terms: z.string().trim().max(4000).nullable().optional(),
    paymentInstructions: z.string().trim().max(4000).nullable().optional(),
    saveAsDraft: z.boolean().default(true),
  })
  .refine((value) => !value.dueDate || value.dueDate >= value.issueDate, {
    message: 'Due date cannot be before the issue date',
    path: ['dueDate'],
  })
  .refine(
    (value) =>
      !value.dueDate ||
      value.dueDate > value.issueDate ||
      value.saveAsDraft === true,
    {
      message:
        'An invoice with a due date on the issue date cannot be sent. Adjust the dates or save as a draft.',
      path: ['dueDate'],
    },
  );

export const updateInvoiceSchema = z
  .object({
    customerId: uuid.optional(),
    issueDate: isoDate.optional(),
    dueDate: isoDate.nullable().optional(),
    currency: currency.optional(),
    items: z.array(invoiceItemInputSchema).min(1).max(100).optional(),
    discountMinor: money.nonnegative().optional(),
    notes: z.string().trim().max(4000).nullable().optional(),
    terms: z.string().trim().max(4000).nullable().optional(),
    paymentInstructions: z.string().trim().max(4000).nullable().optional(),
    reason: z.string().trim().max(500).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Provide at least one field to update',
  });

export const invoiceListQuerySchema = paginationSchema.extend({
  q: z.string().trim().max(120).optional(),
  status: z
    .enum(['all', 'draft', 'sent', 'partially_paid', 'paid', 'overdue', 'void'])
    .default('all'),
  customerId: uuid.optional(),
  issueFrom: isoDate.optional(),
  issueTo: isoDate.optional(),
  dueFrom: isoDate.optional(),
  dueTo: isoDate.optional(),
  currency: currency.optional(),
  sort: z
    .enum(['invoice_number', 'issue_date', 'due_date', 'total_minor', 'balance_minor', 'updated_at'])
    .default('issue_date'),
  order: z.enum(['asc', 'desc']).default('desc'),
});

export const sendInvoiceSchema = z.object({
  sendEmail: z.boolean().default(true),
  recipientEmail: emailSchema.optional(),
});

export const voidInvoiceSchema = z.object({
  reason: z.string().trim().min(3, 'Give a reason').max(500),
});

export const duplicateInvoiceSchema = z.object({
  issueDate: isoDate.optional(),
  dueDate: isoDate.optional(),
});

/* -------------------------------------------------------------------------- */
/* Payments                                                                   */
/* -------------------------------------------------------------------------- */

export const recordPaymentSchema = z
  .object({
    customerId: uuid,
    amountMinor: money.positive('Enter an amount greater than zero'),
    currency,
    method: z.enum(PAYMENT_METHODS),
    paidAt: isoDate,
    reference: z.string().trim().max(200).nullable().optional(),
    fundsReceivedConfirmed: z.literal(true, {
      errorMap: () => ({ message: 'Confirm that the funds were received' }),
    }),
    allocations: z
      .array(
        z.object({
          invoiceId: uuid,
          amountMinor: money.positive(),
        }),
      )
      .min(1, 'Allocate the payment to at least one invoice')
      .max(100)
      .optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.allocations) return;
    const total = value.allocations.reduce((sum, allocation) => sum + allocation.amountMinor, 0);
    if (total !== value.amountMinor) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['allocations'],
        message: `Allocations (${total}) must equal the payment amount (${value.amountMinor})`,
      });
    }
  });

export const allocatePaymentSchema = z.object({
  allocations: z
    .array(
      z.object({
        invoiceId: uuid,
        amountMinor: money.positive(),
      }),
    )
    .min(1)
    .max(100),
});

export const paymentAdjustmentSchema = z.object({
  type: z.enum(['refund', 'reversal', 'chargeback']),
  amountMinor: money.positive(),
  reason: z.string().trim().min(3, 'Give a reason').max(500),
  externalReference: z.string().trim().max(200).nullable().optional(),
});

export const paymentListQuerySchema = paginationSchema.extend({
  q: z.string().trim().max(120).optional(),
  customerId: uuid.optional(),
  invoiceId: uuid.optional(),
  method: z.enum(PAYMENT_METHODS).optional(),
  status: z.enum(['all', 'recorded', 'reversed', 'refunded', 'chargeback']).default('all'),
  from: isoDate.optional(),
  to: isoDate.optional(),
  sort: z.enum(['paid_at', 'amount_minor', 'created_at']).default('paid_at'),
  order: z.enum(['asc', 'desc']).default('desc'),
});

/* -------------------------------------------------------------------------- */
/* Reports / exports                                                          */
/* -------------------------------------------------------------------------- */

export const dashboardQuerySchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  currency: currency.optional(),
});

export const receivablesQuerySchema = z.object({
  asOf: isoDate.optional(),
  currency: currency.optional(),
});

export const collectionsQuerySchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
});

export const createExportSchema = z.object({
  dataset: z.enum(['invoices', 'customers', 'payments', 'aging', 'reminders']),
  filters: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),
});

export const revokePublicLinkSchema = z.object({ reason: z.string().trim().max(300).optional() });

/* -------------------------------------------------------------------------- */
/* Integrations                                                               */
/* -------------------------------------------------------------------------- */

export const updateIntegrationSchema = z.object({
  provider: z.string().trim().min(2).max(64),
  enabled: z.boolean().default(true),
  credentials: z.record(z.string(), z.string().max(2000)).default({}),
});

export const schemaCatalog = {
  register: registerSchema,
  login: loginSchema,
  createOrganization: createOrganizationSchema,
  createCustomer: createCustomerSchema,
  updateCustomer: updateCustomerSchema,
  createInvoice: createInvoiceSchema,
  updateInvoice: updateInvoiceSchema,
  recordPayment: recordPaymentSchema,
};