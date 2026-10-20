import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { PAYMENT_METHODS, type Paginated } from '@collectflow/shared';

import { DataTable, Pagination } from '../components/patterns';
import { Modal } from '../components/Modal';
import { useToast } from '../components/Toast';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Select,
} from '../components/ui';
import { api, ApiError } from '../lib/api';
import { formatDate, formatMoney, todayIso } from '../lib/format';
import { usePermission } from '../lib/session';

interface PaymentRow {
  id: string;
  customerId: string;
  customerName: string;
  amountMinor: number;
  allocatedMinor: number;
  unallocatedMinor: number;
  currency: string;
  method: string;
  source: string;
  status: string;
  reference: string | null;
  paidAt: string;
  invoiceIds: string[];
}

export function PaymentsPage() {
  const { organizationId } = useParams();
  const [params, setParams] = useSearchParams();
  const canRecord = usePermission('payment.record');
  const [recordOpen, setRecordOpen] = useState(false);

  const page = Number(params.get('page') ?? '1');
  const status = params.get('status') ?? 'all';
  const method = params.get('method') ?? '';

  const query = useQuery({
    queryKey: ['payments', organizationId, { page, status, method }],
    queryFn: () => {
      const search = new URLSearchParams({ page: String(page), pageSize: '25', status });
      if (method) search.set('method', method);
      return api.get<Paginated<PaymentRow>>(`/${organizationId}/payments?${search.toString()}`);
    },
    enabled: Boolean(organizationId),
  });

  function update(changes: Record<string, string | number | null>) {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes)) {
      if (value === null || value === '') next.delete(key);
      else next.set(key, String(value));
    }
    setParams(next, { replace: true });
  }

  return (
    <>
      <PageHeader
        title="Payments"
        description="An append-only ledger. Refunds, reversals and chargebacks are recorded as separate entries and never erase the original."
        actions={
          canRecord ? (
            <Button variant="primary" onClick={() => setRecordOpen(true)}>
              Record manual payment
            </Button>
          ) : null
        }
      />

      <Card bodyClassName="p-0">
        <div className="flex flex-wrap items-end gap-3 border-b border-line p-4">
          <div>
            <label htmlFor="payment-status" className="mb-1 block text-[13px] font-medium text-ink">
              Status
            </label>
            <Select id="payment-status" value={status} onChange={(event) => update({ status: event.target.value, page: 1 })}>
              <option value="all">All</option>
              <option value="recorded">Recorded</option>
              <option value="reversed">Reversed</option>
              <option value="refunded">Refunded</option>
              <option value="chargeback">Chargeback</option>
            </Select>
          </div>
          <div>
            <label htmlFor="payment-method" className="mb-1 block text-[13px] font-medium text-ink">
              Method
            </label>
            <Select id="payment-method" value={method} onChange={(event) => update({ method: event.target.value, page: 1 })}>
              <option value="">All methods</option>
              {PAYMENT_METHODS.map((value) => (
                <option key={value} value={value}>
                  {value.replace(/_/g, ' ')}
                </option>
              ))}
            </Select>
          </div>
        </div>

        <DataTable
          caption="Payments"
          rows={query.data?.items ?? []}
          getRowKey={(row) => row.id}
          loading={query.isLoading}
          error={query.error ? 'The payment ledger could not be loaded.' : null}
          onRetry={() => void query.refetch()}
          columns={[
            { key: 'paidAt', header: 'Paid on', render: (row) => formatDate(row.paidAt) },
            {
              key: 'customer',
              header: 'Customer',
              render: (row) => (
                <Link to={`/${organizationId}/customers/${row.customerId}`} className="no-underline">
                  {row.customerName}
                </Link>
              ),
            },
            {
              key: 'amount',
              header: 'Amount',
              align: 'right',
              render: (row) => <span className="tabular font-medium">{formatMoney(row.amountMinor, row.currency)}</span>,
            },
            {
              key: 'allocation',
              header: 'Allocated',
              align: 'right',
              hideOnMobile: true,
              render: (row) => (
                <span className="tabular text-ink-muted">
                  {formatMoney(row.allocatedMinor, row.currency)}
                  {row.unallocatedMinor > 0 ? (
                    <span className="ml-1 text-xs text-[color:var(--color-warning)]">
                      {formatMoney(row.unallocatedMinor, row.currency)} unapplied
                    </span>
                  ) : null}
                </span>
              ),
            },
            {
              key: 'method',
              header: 'Method',
              render: (row) => (
                <span className="capitalize">
                  {row.method.replace(/_/g, ' ')}
                  <span className="ml-1 text-xs text-ink-subtle">
                    ({row.source === 'manual' ? 'manually recorded' : 'provider confirmed'})
                  </span>
                </span>
              ),
            },
            {
              key: 'status',
              header: 'Status',
              render: (row) => (
                <Badge tone={row.status === 'recorded' ? 'success' : row.status === 'reversed' ? 'danger' : 'warning'}>
                  {row.status.replace(/_/g, ' ')}
                </Badge>
              ),
            },
          ]}
          empty={
            <EmptyState
              title="No payments recorded"
              description="Record a bank transfer, cash or cheque payment once the money has actually arrived."
              action={
                canRecord ? (
                  <Button variant="primary" onClick={() => setRecordOpen(true)}>
                    Record a payment
                  </Button>
                ) : undefined
              }
            />
          }
        />

        {query.data ? (
          <Pagination page={query.data.page} pageSize={query.data.pageSize} total={query.data.total} onPageChange={(next) => update({ page: next })} />
        ) : null}
      </Card>

      <RecordUnallocatedPayment
        open={recordOpen}
        onClose={() => setRecordOpen(false)}
        organizationId={organizationId!}
      />
    </>
  );
}

/** Records a payment and allocates it to the customer's open invoices. */
function RecordUnallocatedPayment({
  open,
  onClose,
  organizationId,
}: {
  open: boolean;
  onClose: () => void;
  organizationId: string;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [customerId, setCustomerId] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('bank_transfer');
  const [paidAt, setPaidAt] = useState(todayIso());
  const [reference, setReference] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const customers = useQuery({
    queryKey: ['customer-options', organizationId],
    queryFn: () => api.get<{ options: Array<{ id: string; name: string; currency: string | null }> }>(`/${organizationId}/customers/options?limit=100`),
    enabled: open,
  });

  const mutation = useMutation({
    mutationFn: () =>
      api.post(`/${organizationId}/payments/manual`, {
        customerId,
        amountMinor: Math.round(Number(amount) * 100),
        currency,
        method,
        paidAt,
        reference: reference.trim() || null,
        fundsReceivedConfirmed: true as const,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries();
      toast.success('Payment recorded and allocated to the oldest open invoices first.');
      onClose();
    },
    onError: (mutationError: unknown) =>
      setError(mutationError instanceof ApiError ? mutationError.message : 'The payment could not be recorded.'),
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Record a manual payment"
      description="CollectFlow never holds money. Record a payment only after the funds have actually arrived."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={mutation.isPending}
            disabled={!customerId || !confirmed || Number(amount) <= 0}
            onClick={() => {
              setError(null);
              mutation.mutate();
            }}
          >
            Record payment
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error ? (
          <p role="alert" className="rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-[13px] text-[color:var(--color-danger)]">
            {error}
          </p>
        ) : null}

        <Field label="Customer" required>
          {({ id, describedBy }) => (
            <Select
              id={id}
              aria-describedby={describedBy}
              value={customerId}
              onChange={(event) => {
                setCustomerId(event.target.value);
                const option = customers.data?.options.find((entry) => entry.id === event.target.value);
                if (option?.currency) setCurrency(option.currency);
              }}
            >
              <option value="">Select a customer…</option>
              {(customers.data?.options ?? []).map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Amount" required hint={`In ${currency}`}>
            {({ id, describedBy, invalid }) => (
              <Input id={id} aria-describedby={describedBy} invalid={invalid} inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} />
            )}
          </Field>
          <Field label="Currency" required>
            {({ id, describedBy }) => (
              <Select id={id} aria-describedby={describedBy} value={currency} onChange={(event) => setCurrency(event.target.value)}>
                {(customers.data?.options ?? []).length === 0 ? <option value={currency}>{currency}</option> : null}
                {Array.from(new Set((customers.data?.options ?? []).map((option) => option.currency ?? 'USD')))
                  .concat([currency])
                  .map((code) => (
                    <option key={code} value={code}>
                      {code}
                    </option>
                  ))}
              </Select>
            )}
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Method" required>
            {({ id, describedBy }) => (
              <Select id={id} aria-describedby={describedBy} value={method} onChange={(event) => setMethod(event.target.value)}>
                {PAYMENT_METHODS.filter((value) => value !== 'provider').map((value) => (
                  <option key={value} value={value}>
                    {value.replace(/_/g, ' ')}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Date received" required>
            {({ id, describedBy }) => (
              <Input id={id} aria-describedby={describedBy} type="date" max={todayIso()} value={paidAt} onChange={(event) => setPaidAt(event.target.value)} />
            )}
          </Field>
        </div>

        <Field label="Reference" hint="Optional.">
          {({ id, describedBy }) => (
            <Input id={id} aria-describedby={describedBy} value={reference} onChange={(event) => setReference(event.target.value)} />
          )}
        </Field>

        <label className="flex items-start gap-2 text-[13px] text-ink">
          <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} className="mt-0.5 h-4 w-4 rounded border-line-strong" />
          <span>I confirm the funds were actually received.</span>
        </label>
      </div>
    </Modal>
  );
}