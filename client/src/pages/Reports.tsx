import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';

import { BarChart, DataTable, DefinitionList, ProportionBars } from '../components/patterns';
import { Button, Card, EmptyState, ErrorState, Field, Input, PageHeader } from '../components/ui';
import { api, apiDownload, ApiError } from '../lib/api';
import { addDaysIso, formatMoney, todayIso } from '../lib/format';
import { usePermission } from '../lib/session';

interface ReceivablesReport {
  asOf: string;
  totalsByCurrency: Array<{ currency: string; amountMinor: number }>;
  buckets: Array<{
    bucket: string;
    label: string;
    currency: string | null;
    amountMinor: number;
    invoiceCount: number;
  }>;
  byCustomer: Array<{
    customerId: string;
    customerName: string;
    currency: string;
    amountMinor: number;
    oldestDueDate: string | null;
  }>;
  excluded: { voidInvoices: number };
}

interface CollectionsReport {
  range: { from: string; to: string };
  byMonth: Array<{ month: string; currency: string; amountMinor: number; count: number }>;
  byMethod: Array<{ method: string; currency: string; amountMinor: number; count: number }>;
  invoiceStatusCounts: Array<{ status: string; count: number }>;
  customerBalances: Array<{ customerId: string; customerName: string; currency: string; outstandingMinor: number }>;
  notes: string[];
}

export function ReportsPage() {
  const { organizationId } = useParams();
  const canExport = usePermission('report.export');
  const [tab, setTab] = useState<'receivables' | 'collections'>('receivables');
  const [from, setFrom] = useState(addDaysIso(todayIso(), -180));
  const [to, setTo] = useState(todayIso());
  const [exportError, setExportError] = useState<string | null>(null);

  const receivables = useQuery({
    queryKey: ['receivables', organizationId],
    queryFn: () => api.get<ReceivablesReport>(`/${organizationId}/reports/receivables`),
    enabled: Boolean(organizationId) && tab === 'receivables',
  });

  const collections = useQuery({
    queryKey: ['collections', organizationId, from, to],
    queryFn: () => api.get<CollectionsReport>(`/${organizationId}/reports/collections?from=${from}&to=${to}`),
    enabled: Boolean(organizationId) && tab === 'collections',
  });

  const receivableCurrencies = new Set(
    (receivables.data?.buckets ?? [])
      .map((bucket) => bucket.currency)
      .filter((currency): currency is string => Boolean(currency)),
  );

  return (
    <>
      <PageHeader
        title="Reports"
        description="Every figure comes from persisted records. Void invoices are excluded and currencies are never mixed."
        actions={
          canExport ? (
            <div className="flex gap-2">
              <Button
                onClick={() => {
                  setExportError(null);
                  void apiDownload(`/${organizationId}/exports`, 'invoices.csv', 'POST', { dataset: 'invoices', filters: {} }).catch((error: unknown) =>
                    setExportError(
                      error instanceof ApiError ? error.message : 'The export could not be generated.',
                    ),
                  );
                }}
              >
                Export invoices CSV
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  setExportError(null);
                  void apiDownload(`/${organizationId}/exports`, 'aging.csv', 'POST', { dataset: 'aging', filters: {} }).catch((error: unknown) =>
                    setExportError(
                      error instanceof ApiError ? error.message : 'The export could not be generated.',
                    ),
                  );
                }}
              >
                Export aging CSV
              </Button>
            </div>
          ) : null
        }
      />

      {exportError ? (
        <p role="alert" className="mb-4 rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-[13px] text-[color:var(--color-danger)]">
          {exportError}
        </p>
      ) : null}

      <div className="mb-4 flex gap-1 rounded-lg border border-line bg-white p-1" role="tablist" aria-label="Report type">
        {(['receivables', 'collections'] as const).map((key) => (
          <button
            key={key}
            role="tab"
            type="button"
            aria-selected={tab === key}
            className={`flex-1 rounded-md px-3 py-1.5 text-[13px] font-medium capitalize ${
              tab === key ? 'bg-brand-600 text-white' : 'text-ink-muted hover:bg-surface-sunken'
            }`}
            onClick={() => setTab(key)}
          >
            {key === 'receivables' ? 'Accounts receivable' : 'Collections'}
          </button>
        ))}
      </div>

      {tab === 'receivables' ? (
        receivables.error || !receivables.data ? (
          <ErrorState message="The receivables report could not be loaded." onRetry={() => void receivables.refetch()} />
        ) : (
          <div className="space-y-4">
            <Card
            title="Aging"
            description={`As of ${receivables.data.asOf}. Buckets are calculated from each invoice due date and reported per currency.`}
          >
            {receivableCurrencies.size > 1 ? (
              <p className="mb-3 rounded-lg border border-line bg-surface-sunken px-3 py-2 text-[13px] text-ink-muted">
                This report mixes {receivableCurrencies.size} currencies. CollectFlow stores no exchange rates,
                so amounts are never converted or added together.
              </p>
            ) : null}
              <ProportionBars
                data={receivables.data.buckets
                  .filter((bucket) => bucket.currency !== null)
                  .map((bucket) => ({
                    label: `${bucket.label} (${bucket.invoiceCount})`,
                    amountMinor: bucket.amountMinor,
                    currency: bucket.currency ?? 'USD',
                    detail:
                      receivableCurrencies.size > 1
                        ? 'Proportions are per currency; they are not comparable across currencies.'
                        : undefined,
                  }))}
                format={formatMoney}
              />
              <div className="mt-4 border-t border-line pt-3 text-[13px] text-ink-muted">
                {receivables.data.totalsByCurrency.length === 0 ? (
                  'Nothing is outstanding right now.'
                ) : (
                  <ul className="flex flex-wrap gap-4">
                    {receivables.data.totalsByCurrency.map((entry) => (
                      <li key={entry.currency}>
                        Total outstanding:{' '}
                        <strong className="tabular text-ink">{formatMoney(entry.amountMinor, entry.currency)}</strong>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </Card>

            <Card title="Balance by customer">
              <DataTable
                caption="Outstanding balance by customer"
                rows={receivables.data.byCustomer}
                getRowKey={(row) => `${row.customerId}-${row.currency}`}
                columns={[
                  { key: 'customer', header: 'Customer', render: (row) => row.customerName },
                  {
                    key: 'currency',
                    header: 'Currency',
                    render: (row) => row.currency,
                  },
                  {
                    key: 'amount',
                    header: 'Outstanding',
                    align: 'right',
                    render: (row) => <span className="tabular font-medium">{formatMoney(row.amountMinor, row.currency)}</span>,
                  },
                  {
                    key: 'oldest',
                    header: 'Oldest due',
                    render: (row) => row.oldestDueDate ?? 'No due date',
                  },
                ]}
                empty={
                  <EmptyState
                    title="Nothing outstanding"
                    description="No sent or partially paid invoice has an open balance."
                  />
                }
              />
            </Card>

            <Card title="How this report is built">
              <DefinitionList
                items={[
                  {
                    term: 'Included invoices',
                    description: 'Only invoices with status sent or partially paid, and a balance greater than zero.',
                  },
                  {
                    term: 'Excluded',
                    description: `${receivables.data.excluded.voidInvoices} void invoice(s) are excluded from every total.`,
                  },
                  {
                    term: 'Currency handling',
                    description:
                      'Amounts are grouped per currency. CollectFlow stores no exchange rates, so currencies are never converted or added together.',
                  },
                ]}
              />
            </Card>
          </div>
        )
      ) : collections.error || !collections.data ? (
        <ErrorState message="The collections report could not be loaded." onRetry={() => void collections.refetch()} />
      ) : (
        <div className="space-y-4">
          <Card title="Period">
            <div className="flex flex-wrap items-end gap-3">
              <Field label="From">
                {({ id }) => <Input id={id} type="date" value={from} onChange={(event) => setFrom(event.target.value)} />}
              </Field>
              <Field label="To">
                {({ id }) => <Input id={id} type="date" value={to} onChange={(event) => setTo(event.target.value)} />}
              </Field>
            </div>
          </Card>

          <Card title="Collected per month">
            <BarChart
              label="Payments collected per month"
              data={collections.data.byMonth.map((row) => ({
                label: row.month,
                valueMinor: row.amountMinor,
                currency: row.currency,
                meta: `${row.count} payment(s)`,
              }))}
              format={formatMoney}
              emptyMessage="No payments were recorded in this period."
            />
          </Card>

          <Card title="Payment methods">
            <DataTable
              caption="Payments by method"
              rows={collections.data.byMethod}
              getRowKey={(row) => `${row.method}-${row.currency}`}
              columns={[
                { key: 'method', header: 'Method', render: (row) => <span className="capitalize">{row.method.replace(/_/g, ' ')}</span> },
                { key: 'count', header: 'Payments', align: 'right', render: (row) => String(row.count) },
                {
                  key: 'amount',
                  header: 'Amount',
                  align: 'right',
                  render: (row) => <span className="tabular">{formatMoney(row.amountMinor, row.currency)}</span>,
                },
              ]}
              empty={<EmptyState title="No payments in this period" description="Widen the date range to see activity." />}
            />
          </Card>

          <Card title="Notes">
            <ul className="list-disc space-y-1 pl-5 text-[13px] text-ink-muted">
              {collections.data.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          </Card>
        </div>
      )}
    </>
  );
}