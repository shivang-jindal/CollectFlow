/**
 * Service container. One instance per process; the services are stateless
 * apart from their database handle.
 */

import type { Permission, Role } from '@collectflow/shared';
import { permissionsForRole } from '@collectflow/shared';

import type { AppConfig } from './config.js';
import type { AppDatabase } from './db/client.js';
import { JobQueue } from './jobs/queue.js';
import { DisabledEmailAdapter } from './integrations/email/disabled.js';
import { LogEmailAdapter } from './integrations/email/log.js';
import { SmtpEmailAdapter } from './integrations/email/smtp.js';
import type { EmailAdapter } from './integrations/email/types.js';
import type { Logger } from 'pino';
import { AuditService } from './services/audit.service.js';
import { AuthService } from './services/auth.service.js';
import { CustomerService } from './services/customer.service.js';
import { EmailService } from './services/email.service.js';
import { ExportService } from './services/export.service.js';
import { IntegrationService } from './services/integration.service.js';
import { InvoiceService } from './services/invoice.service.js';
import { OrganizationService } from './services/organization.service.js';
import { PaymentService } from './services/payment.service.js';
import { ReminderService } from './services/reminder.service.js';
import { ReportService } from './services/report.service.js';

export interface Services {
  config: AppConfig;
  logger: Logger;
  db: AppDatabase;
  audit: AuditService;
  auth: AuthService;
  organizations: OrganizationService;
  customers: CustomerService;
  invoices: InvoiceService;
  payments: PaymentService;
  reminders: ReminderService;
  reports: ReportService;
  exports: ExportService;
  email: EmailService;
  emailAdapter: EmailAdapter;
  integrations: IntegrationService;
  jobs: JobQueue;
  permissionsFor: (role: Role) => Permission[];
}

export function createServices(options: {
  db: AppDatabase;
  config: AppConfig;
  logger: Logger;
}): Services {
  const { db, config, logger } = options;

  const adapter = createEmailAdapter(config);
  const audit = new AuditService(db);
  const jobs = new JobQueue(db);
  const auth = new AuthService(db, config.session.ttlHours);
  const organizations = new OrganizationService(db, audit);
  const customers = new CustomerService(db, audit);
  const invoices = new InvoiceService(db, audit);
  const payments = new PaymentService(db, audit, invoices);
  const reminders = new ReminderService(db, jobs, audit);
  const reports = new ReportService(db);
  const exports = new ExportService(db, audit);
  const email = new EmailService(
    db,
    adapter,
    config.email.from ?? 'CollectFlow <no-reply@collectflow.local>',
  );
  const integrations = new IntegrationService(
    db,
    audit,
    config.encryptionKey,
    () => adapter.verifyConfiguration(),
    adapter.setupHint,
    adapter.deliversMessages,
  );

  return {
    config,
    logger,
    db,
    audit,
    auth,
    organizations,
    customers,
    invoices,
    payments,
    reminders,
    reports,
    exports,
    email,
    emailAdapter: adapter,
    integrations,
    jobs,
    permissionsFor: permissionsForRole,
  };
}

export function createEmailAdapter(config: AppConfig): EmailAdapter {
  switch (config.email.provider) {
    case 'smtp':
      return new SmtpEmailAdapter({
        host: config.email.host!,
        port: config.email.port ?? 587,
        secure: config.email.secure,
        user: config.email.user,
        password: config.email.password,
      });
    case 'log':
      return new LogEmailAdapter(`${process.cwd()}/server/.data/outbox`);
    case 'disabled':
    default:
      return new DisabledEmailAdapter();
  }
}