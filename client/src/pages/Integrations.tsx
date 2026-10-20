import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { Badge, Button, Card, EmptyState, Field, Input, PageHeader } from '../components/ui';
import { useToast } from '../components/Toast';
import { api, ApiError } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { usePermission } from '../lib/session';

interface IntegrationStatus {
  provider: 'email_smtp' | 'payment_provider';
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

export function IntegrationsPage() {
  const { organizationId } = useParams();
  const queryClient = useQueryClient();
  const toast = useToast();
  const canManage = usePermission('integration.manage');
  const [testEmail, setTestEmail] = useState('');

  const query = useQuery({
    queryKey: ['integrations', organizationId],
    queryFn: () => api.get<{ integrations: IntegrationStatus[] }>(`/${organizationId}/integrations`),
    enabled: Boolean(organizationId),
  });

  const test = useMutation({
    mutationFn: (provider: string) => api.post<{ ok: boolean; detail: string }>(`/${organizationId}/integrations/${provider}/test`),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries();
      if (result.ok) toast.success(result.detail);
      else toast.error(result.detail);
    },
    onError: (error: unknown) =>
      toast.error(error instanceof ApiError ? error.message : 'The verification action failed.'),
  });

  const sendTest = useMutation({
    mutationFn: () => api.post<{ accepted: boolean; message: string }>(`/${organizationId}/integrations/email_smtp/test-message`, { to: testEmail }),
    onSuccess: (result) => {
      if (result.accepted) toast.success(result.message);
      else toast.error(result.message);
    },
    onError: (error: unknown) =>
      toast.error(error instanceof ApiError ? error.message : 'The test message could not be sent.'),
  });

  return (
    <>
      <PageHeader
        title="Integrations"
        description="Every integration shows its real state. Nothing is reported as connected unless a provider actually confirmed it."
      />

      {query.isLoading ? (
        <p className="text-[13px] text-ink-muted">Loading integration status…</p>
      ) : query.error || !query.data ? (
        <EmptyState title="Could not load integrations" description="Try reloading the page." />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {query.data.integrations.map((integration) => (
            <IntegrationCard
              key={integration.provider}
              integration={integration}
              canManage={canManage}
              testing={test.isPending}
              onTest={() => test.mutate(integration.provider)}
            >
              {integration.provider === 'email_smtp' ? (
                <div className="mt-3 rounded-lg border border-line bg-surface-sunken p-3">
                  <Field label="Send a test message to" hint="Only used to verify the provider accepts your mail.">
                    {({ id, describedBy }) => (
                      <Input
                        id={id}
                        aria-describedby={describedBy}
                        type="email"
                        value={testEmail}
                        onChange={(event) => setTestEmail(event.target.value)}
                      />
                    )}
                  </Field>
                  <Button
                    className="mt-2"
                    size="sm"
                    disabled={!canManage || !testEmail || sendTest.isPending}
                    loading={sendTest.isPending}
                    onClick={() => sendTest.mutate()}
                  >
                    Send test email
                  </Button>
                </div>
              ) : null}
            </IntegrationCard>
          ))}
        </div>
      )}
    </>
  );
}

function IntegrationCard({
  integration,
  canManage,
  testing,
  onTest,
  children,
}: {
  integration: IntegrationStatus;
  canManage: boolean;
  testing: boolean;
  onTest: () => void;
  children?: React.ReactNode;
}) {
  const tone =
    integration.status === 'configured'
      ? 'success'
      : integration.status === 'error'
        ? 'danger'
        : 'neutral';

  const statusLabel =
    integration.status === 'configured'
      ? integration.deliversMessages
        ? 'Connected'
        : 'Configured (development transport)'
      : integration.status === 'error'
        ? 'Error'
        : 'Not connected';

  return (
    <Card
      title={
        <span className="flex flex-wrap items-center gap-2">
          {integration.label}
          <Badge tone={tone}>{statusLabel}</Badge>
        </span>
      }
      description={
        integration.lastCheckedAt
          ? `Last checked ${formatDateTime(integration.lastCheckedAt)}`
          : 'Never verified'
      }
      actions={
        canManage ? (
          <Button size="sm" loading={testing} onClick={onTest}>
            Verify connection
          </Button>
        ) : null
      }
    >
      <div className="space-y-4 text-[13px]">
        {integration.lastErrorMessage ? (
          <p className="rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-[color:var(--color-danger)]">
            {integration.lastErrorMessage}
          </p>
        ) : null}

        {integration.maskedKeys.length > 0 ? (
          <div>
            <h3 className="mb-1">Stored credentials</h3>
            <ul className="space-y-0.5">
              {integration.maskedKeys.map((entry) => (
                <li key={entry.key} className="flex justify-between gap-3 text-ink-muted">
                  <span>{entry.key}</span>
                  <code className="rounded bg-surface-sunken px-1.5 py-0.5 text-xs">{entry.masked}</code>
                </li>
              ))}
            </ul>
            <p className="mt-1 text-xs text-ink-subtle">
              Credentials are encrypted at rest and never displayed again.
            </p>
          </div>
        ) : null}

        <div>
          <h3 className="mb-1">Setup</h3>
          <ol className="list-decimal space-y-1 pl-5 text-ink-muted">
            {integration.setupGuide.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </div>

        <div>
          <h3 className="mb-1">What it does</h3>
          <ul className="list-disc space-y-0.5 pl-5 text-ink-muted">
            {integration.capabilities.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>

        <div>
          <h3 className="mb-1">Limitations</h3>
          <ul className="list-disc space-y-0.5 pl-5 text-ink-muted">
            {integration.limitations.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>

        {children}
      </div>
    </Card>
  );
}