import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { Paginated } from '@collectflow/shared';

import { DataTable, Pagination, StatusBadge } from '../components/patterns';
import { useToast } from '../components/Toast';
import { Badge, Card, Checkbox, EmptyState, ErrorState, PageHeader, Skeleton } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { usePermission } from '../lib/session';

interface ReminderRule {
  id: string;
  name: string;
  offsetDays: number;
  direction: 'before' | 'on' | 'after';
  enabled: boolean;
  templateId: string;
}

interface ReminderSettings {
  rules: ReminderRule[];
  settings: {
    remindersPaused: boolean;
    quietHoursStart: string | null;
    quietHoursEnd: string | null;
    timezone: string;
  } | null;
  email: { provider: string; deliversMessages: boolean; detail: string };
}

interface OutboxMessage {
  id: string;
  templateType: string;
  toAddress: string;
  subject: string;
  status: string;
  providerMessageId: string | null;
  failureCode: string | null;
  safeFailureMessage: string | null;
  sentAt: string | null;
  createdAt: string;
}

export function RemindersPage() {
  const { organizationId } = useParams();
  const queryClient = useQueryClient();
  const toast = useToast();
  const canManage = usePermission('settings.manage');
  const [page, setPage] = useState(1);

  const settings = useQuery({
    queryKey: ['reminder-rules', organizationId],
    queryFn: () => api.get<ReminderSettings>(`/${organizationId}/reminders/rules`),
    enabled: Boolean(organizationId),
  });

  const outbox = useQuery({
    queryKey: ['email-outbox', organizationId],
    queryFn: () =>
      api.get<{ messages: OutboxMessage[]; counts: Record<string, number>; note: string }>(
        `/${organizationId}/reminders/outbox`,
      ),
    enabled: Boolean(organizationId),
  });

  const togglePause = useMutation({
    mutationFn: (paused: boolean) =>
      api.patch(`/${organizationId}/settings/invoices`, { remindersPaused: paused }),
    onSuccess: async () => {
      await queryClient.invalidateQueries();
      toast.success('Reminder schedule updated.');
    },
    onError: (error: unknown) =>
      toast.error(error instanceof ApiError ? error.message : 'Could not update the reminder settings.'),
  });

  const toggleRule = useMutation({
    mutationFn: (rule: ReminderRule) =>
      api.patch(`/${organizationId}/reminders/rules`, {
        rules: [{ id: rule.id, enabled: !rule.enabled, offsetDays: rule.offsetDays, name: rule.name }],
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries();
    },
    onError: (error: unknown) =>
      toast.error(error instanceof ApiError ? error.message : 'Could not update the reminder rule.'),
  });

  const logs = useQuery({
    queryKey: ['reminder-logs', organizationId, page],
    queryFn: () => api.get<Paginated<Record<string, string>>>(
      `/${organizationId}/reminders/logs?page=${page}&pageSize=20`,
    ),
    enabled: Boolean(organizationId),
  });

  if (settings.isLoading) {
    return (
      <>
        <PageHeader title="Reminders" />
        <Skeleton className="h-48" />
      </>
    );
  }

  if (settings.error || !settings.data) {
    return (
      <>
        <PageHeader title="Reminders" />
        <ErrorState message="Reminder settings could not be loaded." onRetry={() => void settings.refetch()} />
      </>
    );
  }

  const data = settings.data;
  const emailReady = data.email.deliversMessages;

  return (
    <>
      <PageHeader
        title="Reminders"
        description="Scheduled reminders follow your workspace timezone and respect quiet hours and customer opt-outs."
      />

      {!emailReady ? (
        <div className="mb-4 rounded-lg border border-warning/30 bg-warning-soft px-3 py-2 text-[13px] text-[color:var(--color-warning)]">
          <strong>Email is not configured.</strong> {data.email.detail} Reminders will be scheduled and logged, but no
          message will leave the system. Invoices can still be downloaded as PDF.
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Schedule" description="Each rule creates one reminder per invoice per target date.">
          <div className="space-y-4">
            <Checkbox
              label="Pause all reminders"
              hint="Nothing is queued or sent while this is on. Existing invoices keep their status."
              checked={data.settings?.remindersPaused ?? true}
              disabled={!canManage || togglePause.isPending}
              onChange={(event) => togglePause.mutate(event.target.checked)}
            />

            <ul className="space-y-2">
              {data.rules.map((rule) => (
                <li key={rule.id} className="flex items-start justify-between gap-3 rounded-lg border border-line p-3">
                  <div>
                    <p className="text-[13px] font-medium text-ink">{rule.name}</p>
                    <p className="text-xs text-ink-muted">
                      {rule.direction === 'before'
                        ? `${rule.offsetDays} days before the due date`
                        : rule.direction === 'on'
                          ? 'On the due date'
                          : `${rule.offsetDays} days after the due date`}
                    </p>
                  </div>
                  <Checkbox
                    label={rule.enabled ? 'On' : 'Off'}
                    checked={rule.enabled}
                    disabled={!canManage || toggleRule.isPending}
                    onChange={() => toggleRule.mutate(rule)}
                  />
                </li>
              ))}
            </ul>

            {data.settings ? (
              <div className="flex flex-wrap gap-4 text-xs text-ink-subtle">
                <span>Timezone: {data.settings.timezone}</span>
                <span>
                  Quiet hours:{' '}
                  {data.settings.quietHoursStart && data.settings.quietHoursEnd
                    ? `${data.settings.quietHoursStart}–${data.settings.quietHoursEnd}`
                    : 'not set'}
                </span>
              </div>
            ) : null}
          </div>
        </Card>

        <Card title="Email outbox" description={outbox.data?.note}>
          {outbox.data && outbox.data.messages.length > 0 ? (
            <DataTable
              caption="Email outbox"
              rows={outbox.data.messages}
              getRowKey={(row) => row.id}
              columns={[
                {
                  key: 'status',
                  header: 'Status',
                  render: (row) => (
                    <Badge
                      tone={
                        row.status === 'sent'
                          ? 'success'
                          : row.status === 'failed'
                            ? 'danger'
                            : 'neutral'
                      }
                    >
                      {row.status}
                    </Badge>
                  ),
                },
                { key: 'to', header: 'To', hideOnMobile: true, render: (row) => row.toAddress },
                {
                  key: 'subject',
                  header: 'Subject',
                  render: (row) => (
                    <span title={row.safeFailureMessage ?? undefined}>{row.subject}</span>
                  ),
                },
                { key: 'createdAt', header: 'Queued', render: (row) => formatDateTime(row.createdAt) },
              ]}
            />
          ) : (
            <EmptyState
              title="Nothing queued yet"
              description="Reminders appear here once they are scheduled for an overdue or upcoming invoice."
            />
          )}
        </Card>
      </div>

      <Card className="mt-4" title="Reminder history">
        <DataTable
          caption="Reminder history"
          rows={logs.data?.items ?? []}
          getRowKey={(row) => String(row.id)}
          loading={logs.isLoading}
          columns={[
            { key: 'status', header: 'Status', render: (row) => <Badge>{String(row.status)}</Badge> },
            { key: 'scheduledFor', header: 'Scheduled', render: (row) => formatDateTime(String(row.scheduledFor)) },
            { key: 'sentAt', header: 'Sent', render: (row) => formatDateTime(String(row.sentAt ?? '')) },
            {
              key: 'failure',
              header: 'Failure',
              render: (row) => String(row.failureCode ?? row.safeFailureMessage ?? '—'),
            },
          ]}
          empty={<EmptyState title="No reminder attempts" description="History appears after the first scheduled reminder runs." />}
        />
        {logs.data ? (
          <Pagination page={logs.data.page} pageSize={logs.data.pageSize} total={logs.data.total} onPageChange={setPage} />
        ) : null}
      </Card>

      <p className="mt-3 text-xs text-ink-subtle">
        A message marked <StatusBadge status="sent" /> means the email provider accepted it. Plain SMTP does not
        report delivery, so CollectFlow never claims an email was delivered.
      </p>
    </>
  );
}