/**
 * Integrations (Part A / A4.12, Part B / B3.9).
 *
 * Each integration reports a truthful status, a setup guide, a verification
 * action and a graceful disconnected state. Credentials are encrypted at rest
 * with AES-256-GCM and never returned to the browser.
 *
 * Payment provider status is intentionally `not_configured` until an operator
 * stores verified merchant credentials. CollectFlow never simulates one.
 */

import { and, eq } from 'drizzle-orm';

import type { AppDatabase } from '../db/client.js';
import { emailMessages, integrations, memberships, users } from '../db/schema.js';
import { notFound, unprocessable } from '../errors.js';
import { maskSecret, openCredentials, sealCredentials } from '../lib/crypto.js';
import type { AuditService } from './audit.service.js';

export type IntegrationProvider = 'email_smtp' | 'payment_provider';

export interface IntegrationStatusView {
  provider: IntegrationProvider;
  label: string;
  status: 'not_configured' | 'configured' | 'error' | 'disabled';
  deliversMessages: boolean;
  lastCheckedAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  maskedKeys: Array<{ key: string; masked: string }>;
  setupGuide: string[];
  capabilities: string[];
  limitations: string[];
}

const PAYMENT_PROVIDER_LIMITATIONS = [
  'CollectFlow records online payments only after a signature-verified provider webhook or server-side API confirmation arrives. A browser success redirect is never treated as proof of payment.',
  'Merchant account approval, settlement and provider fees are outside CollectFlow.',
  'No provider is pre-configured. Until you save verified credentials, online payments are unavailable and only manual (bank transfer, cash, cheque) recording works.',
];

export class IntegrationService {
  constructor(
    private readonly db: AppDatabase,
    private readonly audit: AuditService,
    private readonly encryptionKey: Buffer | null,
    private readonly emailProbe: () => Promise<{ ok: boolean; detail: string }>,
    private readonly emailSetupHint: string,
    private readonly emailDeliversMessages: boolean,
  ) {}

  async list(organizationId: string): Promise<IntegrationStatusView[]> {
    const rows = await this.db
      .select()
      .from(integrations)
      .where(eq(integrations.organizationId, organizationId));

    const email = rows.find((row) => row.provider === 'email_smtp');
    const payment = rows.find((row) => row.provider === 'payment_provider');

    return [
      {
        provider: 'email_smtp',
        label: 'Email (SMTP)',
        status: (email?.status as IntegrationStatusView['status']) ?? 'not_configured',
        deliversMessages: this.emailDeliversMessages,
        lastCheckedAt: email?.lastCheckedAt?.toISOString() ?? null,
        lastErrorCode: email?.lastErrorCode ?? null,
        lastErrorMessage: email?.lastErrorMessage ?? null,
        maskedKeys: email ? await this.describeKeys(organizationId, 'email_smtp') : [],
        setupGuide: [
          this.emailSetupHint,
          'Create or use an SMTP account with your mail provider. Start with sandbox credentials.',
          'Save the host, port, username and password below. Credentials are encrypted with AES-256-GCM before they are stored.',
          'Use "Verify connection" to confirm the provider accepts a connection, then "Send test email".',
          'Only after the provider accepts a message does CollectFlow show it as sent. SMTP does not report delivery, so CollectFlow never claims an email was delivered.',
        ],
        capabilities: [
          'Send invoices',
          'Send scheduled payment reminders',
          'Send a test message to any address you enter',
        ],
        limitations: [
          'Delivery, bounce and open status are not available with plain SMTP.',
          'While email is not configured, invoices can still be downloaded as PDF and payments recorded manually.',
        ],
      },
      {
        provider: 'payment_provider',
        label: 'Online payment provider',
        status: (payment?.status as IntegrationStatusView['status']) ?? 'not_configured',
        deliversMessages: false,
        lastCheckedAt: payment?.lastCheckedAt?.toISOString() ?? null,
        lastErrorCode: payment?.lastErrorCode ?? null,
        lastErrorMessage: payment?.lastErrorMessage ?? null,
        maskedKeys: payment ? await this.describeKeys(organizationId, 'payment_provider') : [],
        setupGuide: [
          'Obtain a merchant account with a payment provider that operates in your country.',
          'Store the provider key id and secret below. They are encrypted at rest and never displayed again.',
          'Register the CollectFlow webhook endpoint with the provider and copy its signing secret into the same record.',
          'Use "Verify connection" before enabling online payment links on invoices.',
        ],
        capabilities: [
          'Signature-verified payment webhooks',
          'Automatic allocation of provider payments to the matching invoice',
        ],
        limitations: PAYMENT_PROVIDER_LIMITATIONS,
      },
    ];
  }

  async save(input: {
    organizationId: string;
    provider: IntegrationProvider;
    actorUserId: string;
    credentials: Record<string, string>;
    enabled: boolean;
  }): Promise<IntegrationStatusView> {
    if (Object.keys(input.credentials).length > 0 && !this.encryptionKey) {
      throw unprocessable(
        'ENCRYPTION_KEY is not configured on the server, so credentials cannot be stored safely. Set ENCRYPTION_KEY and restart the API, or use manual payment recording.',
      );
    }

    const existing = await this.db
      .select()
      .from(integrations)
      .where(
        and(
          eq(integrations.organizationId, input.organizationId),
          eq(integrations.provider, input.provider),
        ),
      )
      .limit(1);

    const sealed =
      Object.keys(input.credentials).length > 0 && this.encryptionKey
        ? sealCredentials(this.encryptionKey, input.credentials)
        : (existing[0]?.encryptedCredentials ?? null);

    const values = {
      encryptedCredentials: sealed,
      status: sealed ? ('configured' as const) : ('not_configured' as const),
      enabled: input.enabled,
      updatedAt: new Date(),
      lastErrorCode: null,
      lastErrorMessage: null,
    };

    if (existing[0]) {
      await this.db
        .update(integrations)
        .set(values)
        .where(eq(integrations.id, existing[0].id));
    } else {
      await this.db.insert(integrations).values({
        organizationId: input.organizationId,
        provider: input.provider,
        ...values,
      });
    }

    await this.audit.record({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      action: 'integration.updated',
      entityType: 'integration',
      entityId: input.provider,
      metadata: { keys: Object.keys(input.credentials), enabled: input.enabled },
    });

    const views = await this.list(input.organizationId);
    return views.find((view) => view.provider === input.provider)!;
  }

  /** Real verification against the provider. Never reports a fake success. */
  async test(
    organizationId: string,
    provider: IntegrationProvider,
    actorUserId: string,
  ): Promise<{ ok: boolean; detail: string; status: IntegrationStatusView['status'] }> {
    if (provider === 'email_smtp') {
      const result = await this.emailProbe();
      await this.persistProbe(organizationId, provider, actorUserId, result.ok, result.detail);
      return {
        ok: result.ok,
        detail: result.detail,
        status: result.ok ? 'configured' : 'error',
      };
    }

    const detail =
      'No online payment provider is configured. CollectFlow cannot verify a provider it has no credentials for. Save provider credentials first, or continue with manual payment recording.';
    await this.persistProbe(organizationId, provider, actorUserId, false, detail);
    return { ok: false, detail, status: 'not_configured' };
  }

  async sendTestEmail(input: {
    organizationId: string;
    actorUserId: string;
    to: string;
    send: (message: { to: string; from: string; subject: string; text: string }) => Promise<{
      accepted: boolean;
      status: 'accepted' | 'rejected';
      providerMessageId?: string;
      message: string;
    }>;
    from: string;
  }) {
    const result = await input.send({
      to: input.to,
      from: input.from,
      subject: 'CollectFlow test email',
      text: [
        'This is a test message from CollectFlow.',
        '',
        'If you received it, the email provider accepted the message. CollectFlow cannot confirm delivery because plain SMTP does not report it.',
      ].join('\n'),
    });

    await this.db.insert(emailMessages).values({
      organizationId: input.organizationId,
      templateType: 'test',
      toAddress: input.to,
      fromAddress: input.from,
      subject: 'CollectFlow test email',
      bodyText: 'CollectFlow test message.',
      status: result.accepted ? 'sent' : 'failed',
      providerMessageId: result.providerMessageId ?? null,
      safeFailureMessage: result.accepted ? null : result.message.slice(0, 300),
      sentAt: result.accepted ? new Date() : null,
    });

    await this.audit.record({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      action: 'integration.test_email_sent',
      entityType: 'integration',
      entityId: 'email_smtp',
      metadata: { accepted: result.accepted },
    });

    return result;
  }

  async clear(organizationId: string, provider: IntegrationProvider, actorUserId: string): Promise<void> {
    const updated = await this.db
      .update(integrations)
      .set({
        encryptedCredentials: null,
        status: 'not_configured',
        enabled: false,
        lastErrorCode: null,
        lastErrorMessage: null,
        updatedAt: new Date(),
      })
      .where(
        and(eq(integrations.organizationId, organizationId), eq(integrations.provider, provider)),
      )
      .returning({ id: integrations.id });
    if (!updated[0]) throw notFound('Integration');
    await this.audit.record({
      organizationId,
      actorUserId,
      action: 'integration.disconnected',
      entityType: 'integration',
      entityId: provider,
    });
  }

  async credentials(organizationId: string, provider: IntegrationProvider): Promise<Record<string, string>> {
    if (!this.encryptionKey) return {};
    const rows = await this.db
      .select()
      .from(integrations)
      .where(
        and(eq(integrations.organizationId, organizationId), eq(integrations.provider, provider)),
      )
      .limit(1);
    const sealed = rows[0]?.encryptedCredentials;
    if (!sealed) return {};
    try {
      return openCredentials(this.encryptionKey, sealed);
    } catch {
      return {};
    }
  }

  /** Masked credential keys - never the plaintext values. */
  private async describeKeys(organizationId: string, provider: IntegrationProvider) {
    const values = await this.credentials(organizationId, provider);
    return Object.entries(values).map(([key, value]) => ({ key, masked: maskSecret(value) ?? '' }));
  }

  private async persistProbe(
    organizationId: string,
    provider: IntegrationProvider,
    actorUserId: string,
    ok: boolean,
    detail: string,
  ): Promise<void> {
    const existing = await this.db
      .select({ id: integrations.id })
      .from(integrations)
      .where(
        and(eq(integrations.organizationId, organizationId), eq(integrations.provider, provider)),
      )
      .limit(1);
    const values = {
      lastCheckedAt: new Date(),
      lastErrorCode: ok ? null : 'verification_failed',
      lastErrorMessage: ok ? null : detail.slice(0, 300),
      status: ok ? ('configured' as const) : ('error' as const),
      updatedAt: new Date(),
    };
    if (existing[0]) {
      await this.db.update(integrations).set(values).where(eq(integrations.id, existing[0].id));
    } else {
      await this.db.insert(integrations).values({ organizationId, provider, ...values });
    }
    await this.audit.record({
      organizationId,
      actorUserId,
      action: 'integration.tested',
      entityType: 'integration',
      entityId: provider,
      metadata: { ok },
    });
  }
}

/** Resolve the owner of an integration record, used to attribute webhooks. */
export async function integrationOwner(db: AppDatabase, organizationId: string): Promise<string | null> {
  const rows = await db
    .select({ userId: memberships.userId })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.organizationId, organizationId), eq(memberships.role, 'owner')))
    .limit(1);
  return rows[0]?.userId ?? null;
}