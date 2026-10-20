import { Router } from 'express';
import { z } from 'zod';

import {
  createCustomerSchema,
  customerListQuerySchema,
  idParamSchema,
  updateCustomerSchema,
} from '@collectflow/shared';

import type { Services } from '../../container.js';
import { asyncHandler, requirePermission } from '../middleware.js';
import { validate } from '../validate.js';

const customerParams = z.object({
  organizationId: idParamSchema.shape.id,
  customerId: idParamSchema.shape.id,
});

export function customerRouter(services: Services): Router {
  // mergeParams keeps `:organizationId` visible to route-level validation.
  const router = Router({ mergeParams: true });

  router.get(
    '/',
    validate({ query: customerListQuerySchema }),
    asyncHandler(async (req, res) => {
      const query = req.query as unknown as {
        page: number;
        pageSize: number;
        q?: string;
        status: 'active' | 'archived' | 'all';
        currency?: string;
        baseCurrency: string;
        sort: 'name' | 'created_at' | 'outstanding';
        order: 'asc' | 'desc';
      };
      res.json(
        await services.customers.list(req.organization!.id, {
          ...query,
          // `outstandingMinor` is denominated in the workspace base currency so
          // it never mixes currencies. The customer detail view shows the full
          // per-currency breakdown.
          baseCurrency: req.organization!.baseCurrency,
        }),
      );
    }),
  );

  router.get(
    '/options',
    validate({ query: z.object({ q: z.string().trim().max(120).optional() }) }),
    asyncHandler(async (req, res) => {
      const q = (req.query as { q?: string }).q;
      res.json({ options: await services.customers.options(req.organization!.id, q) });
    }),
  );

  router.post(
    '/',
    requirePermission('customer.manage'),
    validate({ body: createCustomerSchema }),
    asyncHandler(async (req, res) => {
      const customer = await services.customers.create(
        req.organization!.id,
        req.principal!.user.id,
        req.body as never,
        { requestId: req.requestId },
      );
      res.status(201).json({ customer });
    }),
  );

  router.get(
    '/:customerId',
    validate({ params: customerParams }),
    asyncHandler(async (req, res) => {
      res.json(await services.customers.detail(req.organization!.id, req.params.customerId as string));
    }),
  );

  router.patch(
    '/:customerId',
    requirePermission('customer.manage'),
    validate({ params: customerParams, body: updateCustomerSchema }),
    asyncHandler(async (req, res) => {
      const customer = await services.customers.update(
        req.organization!.id,
        req.principal!.user.id,
        req.params.customerId as string,
        req.body as never,
        { requestId: req.requestId },
      );
      res.json({ customer });
    }),
  );

  router.post(
    '/:customerId/reminder-opt-out',
    requirePermission('customer.manage'),
    validate({ params: customerParams, body: z.object({ optedOut: z.boolean() }) }),
    asyncHandler(async (req, res) => {
      const result = await services.customers.setReminderOptOut(
        req.organization!.id,
        req.params.customerId as string,
        (req.body as { optedOut: boolean }).optedOut,
      );
      res.json(result);
    }),
  );

  return router;
}