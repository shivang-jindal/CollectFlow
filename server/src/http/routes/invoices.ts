import { Router } from 'express';
import { z } from 'zod';

import {
  createInvoiceSchema,
  duplicateInvoiceSchema,
  idParamSchema,
  invoiceListQuerySchema,
  revokePublicLinkSchema,
  sendInvoiceSchema,
  updateInvoiceSchema,
  voidInvoiceSchema,
} from '@collectflow/shared';

import type { Services } from '../../container.js';
import { formatMoney, type TemplateContext } from '../../integrations/email/templates.js';
import { loadInvoiceForPdf, renderInvoicePdf } from '../../pdf/invoice-pdf.js';
import { asyncHandler, requirePermission } from '../middleware.js';
import { validate } from '../validate.js';

const invoiceParams = z.object({
  organizationId: idParamSchema.shape.id,
  invoiceId: idParamSchema.shape.id,
});

export function invoiceRouter(services: Services): Router {
  // mergeParams keeps `:organizationId` visible to route-level validation.
  const router = Router({ mergeParams: true });

  router.get(
    '/',
    validate({ query: invoiceListQuerySchema }),
    asyncHandler(async (req, res) => {
      const query = req.query as never;
      res.json(
        await services.invoices.list(req.organization!.id, req.organization!.timezone, query),
      );
    }),
  );

  router.post(
    '/',
    requirePermission('invoice.create'),
    validate({ body: createInvoiceSchema }),
    asyncHandler(async (req, res) => {
      const body = req.body as {
        customerId: string;
        issueDate: string;
        dueDate?: string | null;
        currency: string;
        items: Array<{
          description: string;
          quantity: string;
          unitPriceMinor: number;
          discountMinor?: number | null;
          taxRateBasisPoints?: number | null;
          sortOrder?: number | null;
        }>;
        discountMinor?: number;
        notes?: string | null;
        terms?: string | null;
        paymentInstructions?: string | null;
        saveAsDraft?: boolean;
      };

      const invoice = await services.invoices.create(
        req.organization!.id,
        req.principal!.user.id,
        body,
        { timezone: req.organization!.timezone, requestId: req.requestId },
      );

      let delivery: { status: string; message: string } | null = null;
      if (body.saveAsDraft === false) {
        const sent = await sendInvoiceEmail(services, req.organization!.id, invoice.id, req.principal!.user.id, {
          organizationName: req.organization!.name,
        });
        delivery = sent.delivery;
      }

      res.status(201).json({
        invoice: {
          ...invoice,
          subtotalMinor: Number(invoice.subtotalMinor),
          discountMinor: Number(invoice.discountMinor),
          taxMinor: Number(invoice.taxMinor),
          totalMinor: Number(invoice.totalMinor),
          issueDate: String(invoice.issueDate).slice(0, 10),
          dueDate: invoice.dueDate ? String(invoice.dueDate).slice(0, 10) : null,
        },
        email: delivery,
      });
    }),
  );

  router.get(
    '/:invoiceId',
    validate({ params: invoiceParams }),
    asyncHandler(async (req, res) => {
      res.json(
        await services.invoices.detail(
          req.organization!.id,
          req.params.invoiceId as string,
          req.organization!.timezone,
        ),
      );
    }),
  );

  router.patch(
    '/:invoiceId',
    requirePermission('invoice.edit'),
    validate({ params: invoiceParams, body: updateInvoiceSchema }),
    asyncHandler(async (req, res) => {
      const invoice = await services.invoices.update(
        req.organization!.id,
        req.principal!.user.id,
        req.params.invoiceId as string,
        req.body as never,
        { requestId: req.requestId },
      );
      res.json({ invoice });
    }),
  );

  router.post(
    '/:invoiceId/send',
    requirePermission('invoice.send'),
    validate({ params: invoiceParams, body: sendInvoiceSchema }),
    asyncHandler(async (req, res) => {
      const body = req.body as { sendEmail: boolean; recipientEmail?: string };
      const result = await sendInvoiceEmail(services, req.organization!.id, req.params.invoiceId as string, req.principal!.user.id, {
        organizationName: req.organization!.name,
        sendEmail: body.sendEmail,
        recipientEmail: body.recipientEmail,
        requestId: req.requestId,
      });
      res.json(result);
    }),
  );

  router.post(
    '/:invoiceId/duplicate',
    requirePermission('invoice.create'),
    validate({ params: invoiceParams, body: duplicateInvoiceSchema }),
    asyncHandler(async (req, res) => {
      const invoice = await services.invoices.duplicate(
        req.organization!.id,
        req.principal!.user.id,
        req.params.invoiceId as string,
        { ...(req.body as { issueDate?: string; dueDate?: string | null }), requestId: req.requestId },
      );
      res.status(201).json({ invoice });
    }),
  );

  router.post(
    '/:invoiceId/void',
    requirePermission('invoice.edit'),
    validate({ params: invoiceParams, body: voidInvoiceSchema }),
    asyncHandler(async (req, res) => {
      const invoice = await services.invoices.voidInvoice(
        req.organization!.id,
        req.principal!.user.id,
        req.params.invoiceId as string,
        (req.body as { reason: string }).reason,
        { requestId: req.requestId },
      );
      await services.reminders.cancelQueued(
        req.organization!.id,
        req.params.invoiceId as string,
        'Invoice was voided.',
      );
      res.json({ invoice });
    }),
  );

  router.post(
    '/:invoiceId/public-link/revoke',
    requirePermission('invoice.send'),
    validate({ params: invoiceParams, body: revokePublicLinkSchema }),
    asyncHandler(async (req, res) => {
      await services.invoices.revokePublicLink(
        req.organization!.id,
        req.principal!.user.id,
        req.params.invoiceId as string,
      );
      res.status(204).end();
    }),
  );

  router.get(
    '/:invoiceId/pdf',
    requirePermission('invoice.create'),
    validate({ params: invoiceParams }),
    asyncHandler(async (req, res) => {
      const data = await loadInvoiceForPdf(services.db, req.organization!.id, req.params.invoiceId as string);
      const pdf = await renderInvoicePdf(data);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader(
        'Content-Disposition',
        `inline; filename="${data.invoice.invoiceNumber.replace(/[^A-Za-z0-9._-]/g, '_')}.pdf"`,
      );
      res.send(pdf);
    }),
  );

  return router;
}

interface SendOptions {
  sendEmail?: boolean;
  recipientEmail?: string;
  requestId?: string | null;
  organizationName: string;
}

export async function sendInvoiceEmail(
  services: Services,
  organizationId: string,
  invoiceId: string,
  actorUserId: string,
  options: SendOptions,
): Promise<{
  invoice: { id: string; status: string; sentAt: string | null; publicUrl: string | null };
  publicToken: string | null;
  delivery: { status: string; message: string; providerMessageId: string | null } | null;
}> {
  const { invoice, publicToken } = await services.invoices.markSent(organizationId, actorUserId, invoiceId, {
    requestId: options.requestId ?? null,
  });

  const publicUrl = publicToken
    ? `${services.config.appUrl}/i/${publicToken}`
    : null;

  let delivery: { status: string; message: string; providerMessageId: string | null } | null = null;

  if (options.sendEmail !== false) {
    const detail = await services.invoices.detail(organizationId, invoiceId, 'UTC');
    const customer = detail.customer as { email?: string | null; name?: string | null } | null;
    const recipient = options.recipientEmail ?? customer?.email ?? null;
    const customerName = customer?.name ?? 'Customer';

    if (!recipient) {
      delivery = {
        status: 'failed',
        message: 'No customer email address is on file, so no email was queued. Download the PDF instead.',
        providerMessageId: null,
      };
    } else {
      const context: TemplateContext = {
        organizationName: options.organizationName,
        customerName: customerName ?? 'Customer',
        invoiceNumber: detail.invoice.invoiceNumber,
        issueDate: detail.invoice.issueDate,
        dueDate: detail.invoice.dueDate,
        totalFormatted: formatMoney(Number(invoice.totalMinor), invoice.currency),
        balanceFormatted: formatMoney(detail.balanceMinor, invoice.currency),
        publicUrl,
        daysUntilDue: detail.invoice.dueDate
          ? Math.round(
              (Date.parse(`${detail.invoice.dueDate}T00:00:00Z`) - Date.now()) / 86_400_000,
            )
          : null,
        notes: detail.invoice.notes,
      };

      const queued = await services.email.queueInvoiceEmail({
        organizationId,
        to: recipient,
        templateType: 'invoice_sent',
        context,
        relatedInvoiceId: invoiceId,
        // One email per invoice per day: a resend must not spam the customer.
        idempotencyKey: `${organizationId}:invoice_sent:${invoiceId}:${new Date().toISOString().slice(0, 10)}`,
      });

      const result = await services.email.deliver(queued.messageId);
      delivery = {
        status: result.status,
        message: result.message,
        providerMessageId: result.providerMessageId,
      };

      await services.audit.record({
        organizationId,
        actorUserId,
        action: 'invoice.email_attempted',
        entityType: 'invoice',
        entityId: invoiceId,
        metadata: { status: result.status, recipient },
        requestId: options.requestId ?? null,
      });
    }
  }

  return {
    invoice: {
      id: invoice.id,
      status: invoice.status,
      sentAt: invoice.sentAt?.toISOString() ?? null,
      publicUrl,
    },
    publicToken,
    delivery,
  };
}