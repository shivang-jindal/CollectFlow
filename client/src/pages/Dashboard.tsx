import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';

import { addDaysIso, todayIso } from '@collectflow/shared';

import { BarChart, CurrencyAmounts, DataTable, DefinitionList, MetricCard, StatusBadge } from '../components/patterns';
import { Button, Card, EmptyState, ErrorState, PageHeader, Skeleton } from '../components/ui';
import { api } from '../lib/api';
import { formatDate, formatMoney } from '../lib/format';
import { useSession } from '../lib/session';

interface DashboardSummary {
  range: { from: string; to: string };
  outstanding: Array<{ currency: string; amountMinor: number }>;
  overdue: Array<{ currency: string; amountMinor: number }>;
  collectedThisMonth: Array<{ currency: string; amountMinor: number }>;
  awaitingPaymentCount: number;
  overdueCount: number;
  draftCount: number;
  customerCount: number;
  recentInvoices: Array<{
    id: string;
    invoiceNumber: string;
    customerName: string;
    issueDate: string;
    dueDate: string | null;
    currency: string;
    totalMinor: number;
    balanceMinor: number;
    displayStatus: string;
  }>;
  recentPayments: Array<{
    id: string;
    customerName: string;
    amountMinor: number;
    currency: string;
    method: string;
    source: string;
    paidAt: string;
  }>;
  followUps: Array<{
    invoiceId: string;
    invoiceNumber: string;
    customerName: string;
    dueDate: string;
    daysOverdue: number;
    currency: string;
    balanceMinor: number;
  }>;
  collectedByMonth: Array<{ month: string; currency: string; amountMinor: number }>;
  definitions: Record<string, string>;
}

const RANGES = [
  { key: '30', label: 'Last 30 days' },
  { key: '90', label: 'Last 90 days' },
  { key: '365', label: 'Last 12 months' },
];

export function DashboardPage() {
  const { organizationId } = useParams();
  const { activeOrganization } = useSession();
  const [range, setRange] = useState('30');

  const to = todayIso();
  const from = addDaysIso(to, -Number(range));

  const summary = useQuery({
    queryKey: ['dashboard', organizationId, from, to],
    queryFn: () => api.get<DashboardSummary>(`/${organizationId}/dashboard?from=${from}&to=${to}`),
    enabled: Boolean(organizationId),
  });

  if (summary.isLoading) {
    return (
      <>
        <PageHeader title="Dashboard" />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((index) => (
            <Skeleton key={index} className="h-28" />
          ))}
        </div>
      </>
    );
  }

  if (summary.error || !summary.data) {
    return (
      <>
        <PageHeader title="Dashboard" />
        <ErrorState
          message="The dashboard could not be loaded."
          onRetry={() => void summary.refetch()}
        />
      </>
    );
  }

  const data = summary.data;
  const isEmpty =
    data.customerCount === 0 && data.recentInvoices.length === 0 && data.recentPayments.length === 0;

  return (
    <>
      <PageHeader
        title="Dashboard"
        description={`${activeOrganization?.organizationName ?? 'Workspace'} · ${formatDate(data.range.from)} to ${formatDate(data.range.to)}`}
        actions={
          <div className="flex items-center gap-2">
            <label htmlFor="dashboard-range" className="text-[13px] text-ink-muted">
              Period
            </label>
            <select
              id="dashboard-range"
              value={range}
              onChange={(event) => setRange(event.target.value)}
              className="h-9 rounded-lg border border-line-strong bg-white px-2 text-[13px]"
            >
              {RANGES.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.label}
                </option>
              ))}
            </select>
            <Link to={`/${organizationId}/invoices/new`}>
              <Button variant="primary">New invoice</Button>
            </Link>
          </div>
        }
      />

      {isEmpty ? (
        <Card>
          <EmptyState
            title="Nothing recorded yet"
            description="CollectFlow starts empty on purpose. Add a customer, then create your first invoice to see outstanding balances and collections here."
            action={
              <div className="flex gap-2">
                <Link to={`/${organizationId}/customers`}>
                  <Button variant="primary">Add a customer</Button>
                </Link>
                <Link to={`/${organizationId}/invoices/new`}>
                  <Button variant="secondary">Create an invoice</Button>
                </Link>
              </div>
            }
          />
        </Card>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <MetricCard
              label="Outstanding"
              hint="Sent and partially paid invoices with a remaining balance."
              value={<CurrencyAmounts amounts={data.outstanding} format={formatMoney} />}
            />
            <MetricCard
              label="Overdue"
              hint="Past the due date in your workspace timezone."
              value={<CurrencyAmounts amounts={data.overdue} format={formatMoney} />}
            />
            <MetricCard
              label="Collected this month"
              hint="Payments recorded in the current calendar month."
              value={<CurrencyAmounts amounts={data.collectedThisMonth} format={formatMoney} />}
            />
            <MetricCard
              label="Invoices awaiting payment"
              value={String(data.awaitingPaymentCount)}
              hint={`${data.overdueCount} overdue · ${data.draftCount} draft · ${data.customerCount} active customers`}
            />
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-3">
            <Card
              className="lg:col-span-2"
              title="Collections over time"
              description="Grouped per month. Amounts in different currencies are never added together."
            >
              <BarChart
                label="Payments collected per month"
                data={data.collectedByMonth.map((entry) => ({
                  label: entry.month,
                  valueMinor: entry.amountMinor,
                  currency: entry.currency,
                }))}
                format={formatMoney}
                emptyMessage="No payments were recorded in this period yet."
              />
            </Card>

            <Card title="Follow-ups" description="Overdue invoices that still need chasing.">
              {data.followUps.length === 0 ? (
                <p className="py-6 text-center text-[13px] text-ink-subtle">Nothing is overdue right now.</p>
              ) : (
                <ul className="divide-y divide-line">
                  {data.followUps.map((item) => (
                    <li key={item.invoiceId} className="py-2.5 first:pt-0 last:pb-0">
                      <Link to={`/${organizationId}/invoices/${item.invoiceId}`} className="no-underline">
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="text-[13px] font-medium text-ink">{item.invoiceNumber}</span>
                          <span className="tabular text-[13px] text-ink">
                            {formatMoney(item.balanceMinor, item.currency)}
                          </span>
                        </div>
                        <p className="text-xs text-ink-muted">
                          {item.customerName} · due {formatDate(item.dueDate)} · {item.daysOverdue} days overdue
                        </p>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <Card
              title="Recent invoices"
              actions={
                <Link to={`/${organizationId}/invoices`}>
                  <Button size="sm" variant="ghost">
                    View all
                  </Button>
                </Link>
              }
            >
              <DataTable
                caption="Recent invoices"
                rows={data.recentInvoices}
                getRowKey={(row) => row.id}
                columns={[
                  {
                    key: 'invoiceNumber',
                    header: 'Invoice',
                    render: (row) => (
                      <Link to={`/${organizationId}/invoices/${row.id}`} className="no-underline">
                        {row.invoiceNumber}
                      </Link>
                    ),
                  },
                  { key: 'customer', header: 'Customer', render: (row) => row.customerName },
                  {
                    key: 'balance',
                    header: 'Balance',
                    align: 'right',
                    render: (row) => <span className="tabular">{formatMoney(row.balanceMinor, row.currency)}</span>,
                  },
                  { key: 'status', header: 'Status', render: (row) => <StatusBadge status={row.displayStatus} /> },
                ]}
              />
            </Card>

            <Card
              title="Recent payments"
              actions={
                <Link to={`/${organizationId}/payments`}>
                  <Button size="sm" variant="ghost">
                    View all
                  </Button>
                </Link>
              }
            >
              <DataTable
                caption="Recent payments"
                rows={data.recentPayments}
                getRowKey={(row) => row.id}
                columns={[
                  { key: 'customer', header: 'Customer', render: (row) => row.customerName },
                  {
                    key: 'amount',
                    header: 'Amount',
                    align: 'right',
                    render: (row) => <span className="tabular">{formatMoney(row.amountMinor, row.currency)}</span>,
                  },
                  {
                    key: 'method',
                    header: 'Method',
                    render: (row) => (
                      <span className="capitalize">
                        {row.method.replace(/_/g, ' ')}
                        {row.source === 'manual' ? (
                          <span className="ml-1 text-xs text-ink-subtle">(manual)</span>
                        ) : null}
                      </span>
                    ),
                  },
                  { key: 'paidAt', header: 'Date', render: (row) => formatDate(row.paidAt) },
                ]}
              />
            </Card>
          </div>

          <Card className="mt-4" title="How these numbers are calculated">
            <DefinitionList
              items={Object.entries(data.definitions).map(([term, description]) => ({ term, description }))}
            />
          </Card>
        </>
      )}
    </>
  );
}

export type { DashboardSummary };