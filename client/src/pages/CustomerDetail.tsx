import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';

import { DataTable, StatusBadge } from '../components/patterns';
import { Badge, Button, Card, EmptyState, ErrorState, PageHeader } from '../components/ui';
import { api } from '../lib/api';
import { formatDate, formatMoney } from '../lib/format';

interface CustomerDetail {
  customer: {
    id: string;
    name: string;
    legalName: string | null;
    email: string | null;
    phone: string | null;
    taxIdentifier: string | null;
    status: 'active' | 'archived';
    currency: string | null;
    notes: string | null;
    reminderOptOut: boolean;
    billingAddress: Record<string, string> | null;
    createdAt: string;
  };
  invoices: Array<{
    id: string;
    invoiceNumber: string;
    status: string;
    issueDate: string;
    dueDate: string | null;
    currency: string;
    totalMinor: number;
    paidMinor: number;
    balanceMinor: number;
  }>;
  payments: Array<{
    id: string;
    amountMinor: number;
    currency: string;
    method: string;
    status: string;
    source: string;
    paidAt: string;
    reference: string | null;
  }>;
  outstandingByCurrency: Array<{ currency: string; amountMinor: number }>;
  timeline: Array<{ id: string; action: string; createdAt: string }>;
}

export function CustomerDetailPage() {
  const { organizationId, customerId } = useParams();

  const query = useQuery({
    queryKey: ['customer', organizationId, customerId],
    queryFn: () => api.get<CustomerDetail>(`/${organizationId}/customers/${customerId}`),
    enabled: Boolean(organizationId && customerId),
  });

  if (query.isLoading) {
    return (
      <>
        <PageHeader title="Customer" />
        <Card>
          <div className="h-32 animate-pulse rounded bg-surface-sunken" />
        </Card>
      </>
    );
  }

  if (query.error || !query.data) {
    return (
      <>
        <PageHeader title="Customer" />
        <ErrorState message="This customer could not be loaded." onRetry={() => void query.refetch()} />
      </>
    );
  }

  const data = query.data;

  return (
    <>
      <PageHeader
        breadcrumb={
          <Link to={`/${organizationId}/customers`} className="no-underline">
            Customers
          </Link>
        }
        title={
          <span className="flex flex-wrap items-center gap-2">
            {data.customer.name}
            {data.customer.status === 'archived' ? <Badge>Archived</Badge> : null}
          </span>
        }
        description={data.customer.legalName ?? undefined}
        actions={
          <Link to={`/${organizationId}/invoices/new`}>
            <Button variant="primary">New invoice</Button>
          </Link>
        }
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card title="Invoices">
            <DataTable
              caption={`Invoices for ${data.customer.name}`}
              rows={data.invoices}
              getRowKey={(row) => row.id}
              rowHref={(row) => `/${organizationId}/invoices/${row.id}`}
              columns={[
                {
                  key: 'number',
                  header: 'Invoice',
                  render: (row) => <span className="font-medium">{row.invoiceNumber}</span>,
                },
                { key: 'issueDate', header: 'Issued', render: (row) => formatDate(row.issueDate) },
                { key: 'dueDate', header: 'Due', render: (row) => formatDate(row.dueDate) },
                {
                  key: 'balance',
                  header: 'Balance',
                  align: 'right',
                  render: (row) => <span className="tabular">{formatMoney(row.balanceMinor, row.currency)}</span>,
                },
                { key: 'status', header: 'Status', render: (row) => <StatusBadge status={row.status} /> },
              ]}
              empty={<EmptyState title="No invoices yet" description="Create the first invoice for this customer." />}
            />
          </Card>

          <Card title="Payments">
            <DataTable
              caption={`Payments for ${data.customer.name}`}
              rows={data.payments}
              getRowKey={(row) => row.id}
              columns={[
                { key: 'paidAt', header: 'Paid on', render: (row) => formatDate(row.paidAt) },
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
                {
                  key: 'amount',
                  header: 'Amount',
                  align: 'right',
                  render: (row) => <span className="tabular">{formatMoney(row.amountMinor, row.currency)}</span>,
                },
                {
                  key: 'status',
                  header: 'Status',
                  render: (row) => (
                    <Badge tone={row.status === 'recorded' ? 'success' : 'warning'}>
                      {row.status.replace(/_/g, ' ')}
                    </Badge>
                  ),
                },
              ]}
              empty={
                <EmptyState
                  title="No payments recorded"
                  description="Record a bank transfer, cash or cheque payment once you have received it."
                />
              }
            />
          </Card>
        </div>

        <div className="space-y-4">
          <Card title="Outstanding balance">
            {data.outstandingByCurrency.length === 0 ? (
              <p className="text-[13px] text-ink-subtle">Nothing outstanding for this customer.</p>
            ) : (
              <ul className="space-y-1">
                {data.outstandingByCurrency.map((entry) => (
                  <li key={entry.currency} className="tabular text-lg font-semibold text-ink">
                    {formatMoney(entry.amountMinor, entry.currency)}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Details">
            <dl className="space-y-2 text-[13px]">
              <Detail term="Email" value={data.customer.email ?? 'Not provided'} />
              <Detail term="Phone" value={data.customer.phone ?? 'Not provided'} />
              <Detail term="Tax identifier" value={data.customer.taxIdentifier ?? 'Not provided'} />
              <Detail
                term="Billing address"
                value={
                  data.customer.billingAddress
                    ? Object.values(data.customer.billingAddress).join(', ')
                    : 'Not provided'
                }
              />
              <Detail term="Reminders" value={data.customer.reminderOptOut ? 'Opted out' : 'Enabled'} />
              <Detail term="Customer since" value={formatDate(data.customer.createdAt)} />
              {data.customer.notes ? <Detail term="Internal notes" value={data.customer.notes} /> : null}
            </dl>
          </Card>

          <Card title="Activity">
            {data.timeline.length === 0 ? (
              <p className="text-[13px] text-ink-subtle">No recorded activity yet.</p>
            ) : (
              <ol className="space-y-2">
                {data.timeline.map((event) => (
                  <li key={event.id} className="text-[13px]">
                    <span className="capitalize text-ink">{event.action.replace(/[._]/g, ' ')}</span>
                    <span className="ml-2 text-xs text-ink-subtle">{formatDate(event.createdAt)}</span>
                  </li>
                ))}
              </ol>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}

function Detail({ term, value }: { term: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-ink-subtle">{term}</dt>
      <dd className="text-ink">{value}</dd>
    </div>
  );
}