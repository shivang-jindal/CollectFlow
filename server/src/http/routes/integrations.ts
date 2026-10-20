import { Router } from 'express';
import { z } from 'zod';

import type { Services } from '../../container.js';
import { integrationUnavailable } from '../../errors.js';
import { asyncHandler, requirePermission } from '../middleware.js';
import { validate } from '../validate.js';

const providerSchema = z.enum(['email_smtp', 'payment_provider']);

export function integrationRouter(services: Services): Router {
  // mergeParams keeps `:organizationId` visible to route-level validation.
  const router = Router({ mergeParams: true });

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      res.json({ integrations: await services.integrations.list(req.organization!.id) });
    }),
  );

  router.put(
    '/:provider',
    requirePermission('integration.manage'),
    validate({
      params: z.object({ organizationId: z.string().uuid(), provider: providerSchema }),
      body: z.object({
        credentials: z.record(z.string(), z.string().max(2000)).default({}),
        enabled: z.boolean().default(true),
      }),
    }),
    asyncHandler(async (req, res) => {
      const body = req.body as { credentials: Record<string, string>; enabled: boolean };
      const integration = await services.integrations.save({
        organizationId: req.organization!.id,
        provider: req.params.provider as 'email_smtp' | 'payment_provider',
        actorUserId: req.principal!.user.id,
        credentials: body.credentials,
        enabled: body.enabled,
      });
      res.json({ integration });
    }),
  );

  router.post(
    '/:provider/test',
    requirePermission('integration.manage'),
    validate({ params: z.object({ organizationId: z.string().uuid(), provider: providerSchema }) }),
    asyncHandler(async (req, res) => {
      const result = await services.integrations.test(
        req.organization!.id,
        req.params.provider as 'email_smtp' | 'payment_provider',
        req.principal!.user.id,
      );
      res.status(result.ok ? 200 : 200).json(result);
    }),
  );

  router.post(
    '/email_smtp/test-message',
    requirePermission('integration.manage'),
    validate({
      body: z.object({ to: z.string().trim().toLowerCase().email('Enter a valid email address') }),
    }),
    asyncHandler(async (req, res) => {
      const verification = await services.emailAdapter.verifyConfiguration();
      if (!verification.ok && services.emailAdapter.deliversMessages) {
        throw integrationUnavailable(verification.detail);
      }
      const result = await services.integrations.sendTestEmail({
        organizationId: req.organization!.id,
        actorUserId: req.principal!.user.id,
        to: (req.body as { to: string }).to,
        from: services.config.email.from ?? 'CollectFlow <no-reply@collectflow.local>',
        send: (message) => services.emailAdapter.send(message),
      });
      res.json(result);
    }),
  );

  router.delete(
    '/:provider',
    requirePermission('integration.manage'),
    validate({ params: z.object({ organizationId: z.string().uuid(), provider: providerSchema }) }),
    asyncHandler(async (req, res) => {
      await services.integrations.clear(
        req.organization!.id,
        req.params.provider as 'email_smtp' | 'payment_provider',
        req.principal!.user.id,
      );
      res.status(204).end();
    }),
  );

  return router;
}