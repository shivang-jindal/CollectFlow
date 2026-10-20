import { Router } from 'express';
import { z } from 'zod';

import {
  collectionsQuerySchema,
  createExportSchema,
  dashboardQuerySchema,
  idParamSchema,
  receivablesQuerySchema,
  updateReminderRulesSchema,
} from '@collectflow/shared';

import type { Services } from '../../container.js';
import { asyncHandler, requirePermission } from '../middleware.js';
import { validate } from '../validate.js';

export function reportingRouter(services: Services): Router {
  // mergeParams keeps `:organizationId` visible to route-level validation.
  const router = Router({ mergeParams: true });

  router.get(
    '/dashboard',
    validate({ query: dashboardQuerySchema }),
    asyncHandler(async (req, res) => {
      const query = req.query as { from?: string; to?: string };
      res.json(
        await services.reports.dashboard(req.organization!.id, req.organization!.timezone, {
          ...(query.from ? { from: query.from } : {}),
          ...(query.to ? { to: query.to } : {}),
        }),
      );
    }),
  );

  router.get(
    '/reports/receivables',
    validate({ query: receivablesQuerySchema }),
    asyncHandler(async (req, res) => {
      const query = req.query as { asOf?: string; currency?: string };
      res.json(
        await services.reports.receivables(req.organization!.id, {
          ...(query.asOf ? { asOf: query.asOf } : {}),
          ...(query.currency ? { currency: query.currency } : {}),
        }),
      );
    }),
  );

  router.get(
    '/reports/collections',
    validate({ query: collectionsQuerySchema }),
    asyncHandler(async (req, res) => {
      const query = req.query as { from?: string; to?: string };
      res.json(
        await services.reports.collections(req.organization!.id, {
          ...(query.from ? { from: query.from } : {}),
          ...(query.to ? { to: query.to } : {}),
        }),
      );
    }),
  );

  router.post(
    '/exports',
    requirePermission('report.export'),
    validate({ body: createExportSchema }),
    asyncHandler(async (req, res) => {
      const { dataset } = req.body as { dataset: 'invoices' | 'customers' | 'payments' | 'aging' | 'reminders' };
      const result = await services.exports.build(
        req.organization!.id,
        dataset,
        req.principal!.user.id,
        { requestId: req.requestId },
      );
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
      res.setHeader('X-Row-Count', String(result.rowCount));
      res.send(result.csv);
    }),
  );

  /* ---------------------------------------------------------------------- */
  /* Reminder configuration and history                                     */
  /* ---------------------------------------------------------------------- */

  router.get(
    '/reminders/rules',
    asyncHandler(async (req, res) => {
      const [rules, settings, verification] = await Promise.all([
        services.organizations.listReminderRules(req.organization!.id),
        services.organizations.getSettings(req.organization!.id),
        services.emailAdapter.verifyConfiguration(),
      ]);
      res.json({
        rules,
        settings: settings
          ? {
              remindersPaused: settings.remindersPaused,
              quietHoursStart: settings.quietHoursStart,
              quietHoursEnd: settings.quietHoursEnd,
              timezone: req.organization!.timezone,
            }
          : null,
        email: {
          provider: services.emailAdapter.name,
          deliversMessages: services.emailAdapter.deliversMessages,
          detail: verification.detail,
        },
      });
    }),
  );

  router.patch(
    '/reminders/rules',
    requirePermission('settings.manage'),
    validate({ body: updateReminderRulesSchema }),
    asyncHandler(async (req, res) => {
      const body = req.body as { rules: Array<{ id: string; enabled: boolean; offsetDays?: number; name?: string }> };
      res.json({
        rules: await services.organizations.updateReminderRules(
          req.organization!.id,
          req.principal!.user.id,
          body.rules,
        ),
      });
    }),
  );

  router.get(
    '/reminders/logs',
    validate({
      query: z.object({
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(25),
        invoiceId: idParamSchema.shape.id.optional(),
        status: z.string().trim().max(30).optional(),
        from: z.string().trim().max(10).optional(),
        to: z.string().trim().max(10).optional(),
      }),
    }),
    asyncHandler(async (req, res) => {
      const query = req.query as unknown as {
        page: number;
        pageSize: number;
        invoiceId?: string;
        status?: string;
        from?: string;
        to?: string;
      };
      res.json(await services.reminders.listLogs(req.organization!.id, query));
    }),
  );

  router.get(
    '/reminders/outbox',
    asyncHandler(async (req, res) => {
      res.json({
        messages: await services.email.outbox(req.organization!.id, 50),
        counts: await services.email.stats(req.organization!.id),
        note: 'A message marked "sent" means the email provider accepted it for delivery. SMTP does not report delivery, so CollectFlow never claims an email was delivered.',
      });
    }),
  );

  router.post(
    '/reminders/preview/:invoiceId',
    asyncHandler(async (req, res) => {
      const preview = await services.reminders.preview(
        req.organization!.id,
        req.params.invoiceId as string,
      );
      if (!preview) {
        res.status(404).json({
          error: { code: 'NOT_FOUND', message: 'Invoice was not found.', requestId: req.requestId },
        });
        return;
      }
      res.json({ preview });
    }),
  );

  return router;
}