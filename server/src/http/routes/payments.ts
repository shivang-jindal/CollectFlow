import { Router } from 'express';
import { z } from 'zod';

import {
  allocatePaymentSchema,
  idParamSchema,
  paymentAdjustmentSchema,
  paymentListQuerySchema,
  recordPaymentSchema,
} from '@collectflow/shared';

import type { Services } from '../../container.js';
import { asyncHandler, requirePermission } from '../middleware.js';
import { validate } from '../validate.js';

const paymentParams = z.object({
  organizationId: idParamSchema.shape.id,
  paymentId: idParamSchema.shape.id,
});

export function paymentRouter(services: Services): Router {
  // mergeParams keeps `:organizationId` visible to route-level validation.
  const router = Router({ mergeParams: true });

  router.get(
    '/',
    validate({ query: paymentListQuerySchema }),
    asyncHandler(async (req, res) => {
      const query = req.query as unknown as {
        page: number;
        pageSize: number;
        q?: string;
        customerId?: string;
        invoiceId?: string;
        method?: string;
        status: string;
        from?: string;
        to?: string;
        sort: string;
        order: 'asc' | 'desc';
      };
      res.json(await services.payments.list(req.organization!.id, query));
    }),
  );

  router.post(
    '/manual',
    requirePermission('payment.record'),
    validate({ body: recordPaymentSchema }),
    asyncHandler(async (req, res) => {
      const settings = await services.organizations.getSettings(req.organization!.id);
      if (settings && !settings.allowManualPayments) {
        res.status(422).json({
          error: {
            code: 'UNPROCESSABLE',
            message:
              'Manual payment recording is disabled for this organization. An owner or admin can enable it in Settings.',
            requestId: req.requestId,
          },
        });
        return;
      }

      const body = req.body as {
        customerId: string;
        amountMinor: number;
        currency: string;
        method: string;
        paidAt: string;
        reference?: string | null;
        allocations?: Array<{ invoiceId: string; amountMinor: number }>;
      };

      const result = await services.payments.recordManual(req.organization!.id, req.principal!.user.id, {
        ...body,
        requestId: req.requestId,
      });

      for (const updated of result.updatedInvoices) {
        await services.reminders.cancelQueued(
          req.organization!.id,
          updated.id,
          updated.status === 'paid' ? 'Invoice was paid.' : 'Payment recorded.',
        );
      }

      res.status(201).json(result);
    }),
  );

  router.post(
    '/:paymentId/allocate',
    requirePermission('payment.record'),
    validate({ params: paymentParams, body: allocatePaymentSchema }),
    asyncHandler(async (req, res) => {
      res.json(
        await services.payments.allocate(
          req.organization!.id,
          req.principal!.user.id,
          req.params.paymentId as string,
          (req.body as { allocations: Array<{ invoiceId: string; amountMinor: number }> }).allocations,
          { requestId: req.requestId },
        ),
      );
    }),
  );

  router.post(
    '/:paymentId/adjustments',
    requirePermission('payment.record'),
    validate({ params: paymentParams, body: paymentAdjustmentSchema }),
    asyncHandler(async (req, res) => {
      res.json(
        await services.payments.addAdjustment(
          req.organization!.id,
          req.principal!.user.id,
          req.params.paymentId as string,
          req.body as never,
        ),
      );
    }),
  );

  return router;
}