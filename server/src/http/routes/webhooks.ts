import { Router } from 'express';
import rateLimit from 'express-rate-limit';

import { sha256Hex } from '../../lib/crypto.js';
import { webhookEvents } from '../../db/schema.js';
import type { Services } from '../../container.js';
import { integrationUnavailable } from '../../errors.js';
import { asyncHandler } from '../middleware.js';

export function webhookRouter(services: Services): Router {
  const router = Router();

  const webhookLimit = rateLimit({
    windowMs: 60_000,
    limit: services.config.rateLimit.authMax,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
  });

  /**
   * Payment provider webhook.
   *
   * There is no provider adapter in this release, so the route refuses the
   * request with a clear "configuration required" answer instead of pretending
   * to accept a payment (Part A / A4.15, Part B / B3.9).
   */
  router.post(
    '/payments/:provider',
    webhookLimit,
    asyncHandler(async (req) => {
      const provider = req.params.provider as string;
      const eventId =
        (req.body as { event?: { id?: string }; id?: string })?.event?.id ??
        (req.body as { id?: string })?.id ??
        `unverified-${sha256Hex(JSON.stringify(req.body)).slice(0, 24)}`;

      await services.db
        .insert(webhookEvents)
        .values({
          provider,
          providerEventId: eventId,
          payloadHash: sha256Hex(JSON.stringify(req.body ?? {})),
          status: 'rejected',
          errorCode: 'provider_not_configured',
        })
        .onConflictDoNothing();

      throw integrationUnavailable(
        'No payment provider adapter is configured, so this webhook cannot be verified or processed. Nothing has been recorded as paid.',
        { provider },
      );
    }),
  );

  return router;
}