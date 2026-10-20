/**
 * Public, unauthenticated routes.
 *
 * `GET /api/v1/public/invoices/:token` exposes only the fields a customer needs
 * to view and pay an invoice. Internal ids, organization records, customer
 * contact details and audit data are never included.
 */

import { Router } from 'express';
import { eq, sql } from 'drizzle-orm';

import { deriveDisplayStatus, formatMinorAsDecimal, todayIso } from '@collectflow/shared';
import { rateLimit } from 'express-rate-limit';

import type { Services } from '../../container.js';
import { customers, invoiceItems, invoices, organizations } from '../../db/schema.js';
import { effectiveAllocatedSql } from '../../db/balance-sql.js';
import { asyncHandler } from '../middleware.js';

export function publicRouter(services: Services): Router {
  const router = Router();

  const publicLimit = rateLimit({
    windowMs: 60_000,
    limit: 30,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: {
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many requests for invoice links. Please wait a moment and try again.',
      },
    },
  });

  router.get(
    '/invoices/:token',
    publicLimit,
    asyncHandler(async (req, res) => {
      const token = req.params.token as string;
      if (!/^[A-Za-z0-9_-]{32,64}$/.test(token)) {
        res.status(404).json({
          error: { code: 'NOT_FOUND', message: 'This invoice link is not valid.', requestId: req.requestId },
        });
        return;
      }

      const invoice = await services.invoices.findByPublicToken(token);
      if (!invoice) {
        res.status(404).json({
          error: { code: 'NOT_FOUND', message: 'This invoice link is not valid or has been revoked.', requestId: req.requestId },
        });
        return;
      }

      const [organization, customer, items] = await Promise.all([
        services.db.select().from(organizations).where(eq(organizations.id, invoice.organizationId)).limit(1),
        services.db.select().from(customers).where(eq(customers.id, invoice.customerId)).limit(1),
        services.db
          .select()
          .from(invoiceItems)
          .where(eq(invoiceItems.invoiceId, invoice.id))
          .orderBy(invoiceItems.sortOrder),
      ]);

      const allocated = await services.db
        .select({
          amount: effectiveAllocatedSql(sql`${invoice.id}`, sql`${invoice.organizationId}`),
        })
        .from(invoices)
        .where(eq(invoices.id, invoice.id));

      const paidMinor = Number(allocated[0]?.amount ?? 0);
      const totalMinor = Number(invoice.totalMinor);
      const balanceMinor = invoice.status === 'void' ? 0 : totalMinor - paidMinor;
      const org = organization[0];
      const customerRecord = customer[0];

      res.json({
        // Only these fields are intentionally public.
        organization: { name: org?.name ?? '', address: [org?.addressLine1, org?.city, org?.countryCode].filter(Boolean) },
        customer: { name: customerRecord?.name ?? '' },
        invoice: {
          number: invoice.invoiceNumber,
          issueDate: String(invoice.issueDate).slice(0, 10),
          dueDate: invoice.dueDate ? String(invoice.dueDate).slice(0, 10) : null,
          currency: invoice.currency,
          status: deriveDisplayStatus(
            invoice.status as never,
            invoice.dueDate ? String(invoice.dueDate).slice(0, 10) : null,
            balanceMinor,
            todayIso(org?.timezone ?? 'UTC'),
          ),
          subtotal: formatMinorAsDecimal(Number(invoice.subtotalMinor), invoice.currency),
          discount: formatMinorAsDecimal(Number(invoice.discountMinor), invoice.currency),
          tax: formatMinorAsDecimal(Number(invoice.taxMinor), invoice.currency),
          total: formatMinorAsDecimal(totalMinor, invoice.currency),
          paid: formatMinorAsDecimal(paidMinor, invoice.currency),
          balance: formatMinorAsDecimal(balanceMinor, invoice.currency),
          notes: invoice.notes,
          terms: invoice.terms,
          paymentInstructions: invoice.paymentInstructions,
        },
        items: items.map((item) => ({
          description: item.description,
          quantity: item.quantity,
          unitPrice: formatMinorAsDecimal(Number(item.unitPriceMinor), invoice.currency),
          amount: formatMinorAsDecimal(Number(item.lineTotalMinor), invoice.currency),
        })),
        onlinePayment: {
          available: false,
          reason:
            'No online payment provider is configured for this organization. Please use the payment instructions on the invoice.',
        },
      });
    }),
  );

  return router;
}