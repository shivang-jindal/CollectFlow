/**
 * Development / demo seed (`npm run db:seed`).
 *
 * Seed data is only ever created by this explicit command (Part A / A4.5). A
 * production account always starts empty.
 */

import { eq } from 'drizzle-orm';

import { loadConfig } from '../config.js';
import { createDatabase, runMigrations } from './client.js';
import { createServices } from '../container.js';
import { createLogger } from '../logger.js';
import { addDaysIso, todayIso } from '@collectflow/shared';

const DEMO_EMAIL = process.env.SEED_EMAIL ?? 'demo@collectflow.test';
const DEMO_PASSWORD = process.env.SEED_PASSWORD ?? 'collectflow-demo-1234';

async function main(): Promise<void> {
  const config = loadConfig();
  if (config.isProduction) {
    throw new Error('Refusing to seed a production database. Run the seed command against a development database.');
  }

  const database = await createDatabase({
    databaseUrl: config.databaseUrl,
    pgliteDataDir: config.pgliteDataDir,
  });
  await runMigrations(database);

  const logger = createLogger({ level: 'info', isProduction: false, name: 'seed' });
  const services = createServices({ db: database.db, config, logger });

  try {
    const { users } = await import('./schema.js');
    const existing = await database.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, DEMO_EMAIL))
      .limit(1);

    if (existing[0]) {
      console.log(`[db:seed] ${DEMO_EMAIL} already exists; nothing to do.`);
      return;
    }

    const { user, session } = await services.auth.register({
      email: DEMO_EMAIL,
      password: DEMO_PASSWORD,
      displayName: 'Demo Owner',
    });

    const organization = await services.organizations.create({
      name: 'Demo Studio',
      countryCode: 'US',
      timezone: 'America/New_York',
      baseCurrency: 'USD',
      ownerId: user.id,
    });
    await services.email.seedTemplates(organization.id);
    await services.organizations.updateSettings(organization.id, user.id, {
      defaultPaymentInstructions: 'Demo Studio Bank\nAccount 12345678\nSort 01-02-03',
      defaultTerms: 'Payment due within 14 days.',
    });
    await services.organizations.ensureDefaultReminderRules(organization.id);

    const acme = await services.customers.create(organization.id, user.id, {
      name: 'Acme Robotics',
      legalName: 'Acme Robotics Ltd',
      email: 'billing@acme.example',
      phone: '+1 415 555 0100',
      currency: 'USD',
      billingAddress: {
        line1: '22 Mission Street',
        city: 'San Francisco',
        region: 'CA',
        postalCode: '94105',
        countryCode: 'US',
      },
    });
    const northwind = await services.customers.create(organization.id, user.id, {
      name: 'Northwind Traders',
      email: 'accounts@northwind.example',
      currency: 'USD',
    });

    const today = todayIso('America/New_York');
    const draft = await services.invoices.create(
      organization.id,
      user.id,
      {
        customerId: acme.id,
        issueDate: today,
        dueDate: addDaysIso(today, 21),
        currency: 'USD',
        items: [
          { description: 'Discovery workshop (2 days)', quantity: '2', unitPriceMinor: 120000 },
          { description: 'Integration audit', quantity: '1', unitPriceMinor: 45000, taxRateBasisPoints: 0 },
        ],
        saveAsDraft: true,
      },
      { timezone: 'America/New_York' },
    );

    const sent = await services.invoices.create(
      organization.id,
      user.id,
      {
        customerId: northwind.id,
        issueDate: addDaysIso(today, -30),
        dueDate: addDaysIso(today, -10),
        currency: 'USD',
        items: [
          { description: 'Retainer - March', quantity: '1', unitPriceMinor: 250000, taxRateBasisPoints: 500 },
        ],
        saveAsDraft: true,
      },
      { timezone: 'America/New_York' },
    );
    await services.invoices.markSent(organization.id, user.id, draft.id, {});
    await services.invoices.markSent(organization.id, user.id, sent.id, {});

    await services.payments.recordManual(organization.id, user.id, {
      customerId: acme.id,
      amountMinor: 120000,
      currency: 'USD',
      method: 'bank_transfer',
      paidAt: addDaysIso(today, -5),
      reference: 'DEMO-TRANSFER-1',
    });
    await services.payments.recordManual(organization.id, user.id, {
      customerId: acme.id,
      amountMinor: 50000,
      currency: 'USD',
      method: 'bank_transfer',
      paidAt: addDaysIso(today, -2),
      reference: 'DEMO-TRANSFER-2',
    });
    await services.payments.recordManual(organization.id, user.id, {
      customerId: northwind.id,
      amountMinor: 100000,
      currency: 'USD',
      method: 'bank_transfer',
      paidAt: addDaysIso(today, -12),
      reference: 'DEMO-TRANSFER-3',
    });

    console.log('[db:seed] demo workspace created.');
    console.log(`           email:    ${DEMO_EMAIL}`);
    console.log(`           password: ${DEMO_PASSWORD}`);
    console.log(`           organization: ${organization.name} (${organization.slug})`);
    console.log(`           invoice 1: ${draft.invoiceNumber} (partially paid)`);
    console.log(`           invoice 2: ${sent.invoiceNumber} (overdue)`);
    void session;
  } finally {
    await database.close();
  }
}

main().catch((error: unknown) => {
  console.error('[db:seed] failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});