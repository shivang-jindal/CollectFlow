/**
 * API router assembly (Part A / A7): everything lives under `/api/v1`.
 */

import { Router, type ErrorRequestHandler, type RequestHandler } from 'express';

import type { Services } from '../../container.js';
import { AppError } from '../../errors.js';
import {
  asyncHandler,
  requireAuth,
  requireAuthenticated,
  requireOrganization,
} from '../middleware.js';
import { authRouter } from './auth.js';
import { customerRouter } from './customers.js';
import { healthRouter } from './health.js';
import { integrationRouter } from './integrations.js';
import { invoiceRouter } from './invoices.js';
import { organizationRouter } from './organization.js';
import { paymentRouter } from './payments.js';
import { publicRouter } from './public.js';
import { reportingRouter } from './reporting.js';
import { webhookRouter } from './webhooks.js';

export function createApiRouter(services: Services): Router {
  const router = Router();

  router.use('/health', healthRouter(services));

  // Public routes are deliberately mounted before authentication.
  router.use('/public', publicRouter(services));
  router.use('/webhooks', webhookRouter(services));

  // `requireAuth` only ATTACHES the principal; it never rejects. It must be
  // mounted before `/auth`, because a sub-router that handles a request never
  // falls through to middleware registered after it - so several `/auth`
  // routes (session, create organization, switch organization, accept
  // invitation) would otherwise run without a principal and always 401.
  router.use(requireAuth(services));
  router.use('/auth', authRouter(services));

  // Everything past this point requires a session. Sign-in and registration
  // are handled by `authRouter` above and stay reachable anonymously.
  router.use(requireAuthenticated());

  router.get(
    '/session/context',
    asyncHandler(async (req, res) => {
      const memberships = await services.auth.membershipsFor(req.principal!.user.id);
      res.json({
        user: req.principal!.user,
        memberships,
        activeOrganizationId: req.principal!.activeOrganizationId,
      });
    }),
  );

  // `mergeParams` is required so `:organizationId` from the mount path is
  // visible to `requireOrganization` inside the sub-router.
  const organizationScoped = Router({ mergeParams: true });
  organizationScoped.use(requireOrganization(services));

  organizationScoped.use('/customers', customerRouter(services));
  organizationScoped.use('/invoices', invoiceRouter(services));
  organizationScoped.use('/payments', paymentRouter(services));
  organizationScoped.use('/integrations', integrationRouter(services));
  organizationScoped.use('/', organizationRouter(services));
  organizationScoped.use('/', reportingRouter(services));

  router.use('/:organizationId', organizationScoped);

  return router;
}

export function notFoundHandler(): RequestHandler {
  return (req, res) => {
    res.status(404).json({
      error: {
        code: 'NOT_FOUND',
        message: `No route matches ${req.method} ${req.path}.`,
        requestId: req.requestId,
      },
    });
  };
}

/** One error shape for the whole API; stack traces stay in the log only. */
export function errorHandler(services: Services): ErrorRequestHandler {
  return (error, req, res, _next) => {
    if (res.headersSent) return;

    if (error instanceof AppError) {
      if (error.status >= 500) {
        services.logger.error({ err: error, requestId: req.requestId }, 'request failed');
      } else {
        services.logger.debug(
          { code: error.code, requestId: req.requestId, path: req.path },
          'request rejected',
        );
      }
      res.status(error.status).json({
        error: {
          code: error.code,
          message: error.expose ? error.message : 'Something went wrong. Please try again.',
          ...(error.fields ? { fields: error.fields } : {}),
          ...(error.issues ? { issues: error.issues } : {}),
          requestId: req.requestId,
        },
      });
      return;
    }

    // Zod errors that escaped an explicit validate() call.
    if (error && typeof error === 'object' && 'issues' in error) {
      const issues = (error as { issues: Array<{ path: unknown[]; message: string }> }).issues;
      res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Some of the values you entered are not valid.',
          issues: issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
          requestId: req.requestId,
        },
      });
      return;
    }

    if (error instanceof SyntaxError && 'body' in error) {
      res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'Request body is not valid JSON.', requestId: req.requestId },
      });
      return;
    }

    services.logger.error({ err: error, requestId: req.requestId }, 'unhandled error');
    res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Something went wrong. Please try again.',
        requestId: req.requestId,
      },
    });
  };
}