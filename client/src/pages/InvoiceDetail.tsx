import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { PAYMENT_METHODS } from '@collectflow/shared';

import { ActivityTimeline, CopyButton, DataTable, StatusBadge } from '../components/patterns';
import { useToast } from '../components/Toast';
import { ConfirmDialog, Modal } from '../components/Modal';
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Input,
  PageHeader,
  Select,
  Textarea,
} from '../components/ui';
import { api, apiDownload, ApiError } from '../lib/api';
import { formatDate, formatDateTime, formatMoney, todayIso } from '../lib/format';
import { useSession } from '../lib/session';

interface InvoiceDetail {
  invoice: {
    id: string;
    invoiceNumber: string;
    status: string;
    displayStatus: string;
    issueDate: string;
    dueDate: string | null;
    currency: string;
    subtotalMinor: number;
    discountMinor: number;
    taxMinor: number;
    totalMinor: number;
    notes: string | null;
    terms: string | null;
    paymentInstructions: string | null;
    sentAt: string | null;
    paidAt: string | null;
    voidedAt: string | null;
    voidReason: string | null;
    publicLinkActive: boolean;
    version: number;
  };
  customer: { id: string; name: string; email: string | null; phone: string | null } | null;
  items: Array<{
    id: string;
    description: string;
    quantity: string;
    unitPriceMinor: number;
    discountMinor: number;
    taxRateBasisPoints: number;
    lineTotalMinor: number;
  }>;
  allocations: Array<{
    id: string;
    amountMinor: number;
    paymentId: string;
    paymentMethod: string;
    paymentSource: string;
    paidAt: string;
    createdAt: string;
  }>;
  paidMinor: number;
  balanceMinor: number;
  timeline: Array<{ id: string; action: string; createdAt: string; actorUserId: string | null }>;
}

export function InvoiceDetailPage() {
  const { organizationId, invoiceId } = useParams();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { permissions, activeOrganization } = useSession();
  const canEdit = permissions.includes('invoice.edit');
  const canSend = permissions.includes('invoice.send');
  const canRecordPayment = permissions.includes('payment.record');

  const [voidOpen, setVoidOpen] = useState(false);
  const[voidReason, setVoidReason] = useState('');
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [publicUrl, setPublicUrl] = useState<string | null>(null);

  const detail = useQuery({
    queryKey: ['invoice', organizationId, invoiceId],
    queryFn: () => api.get<InvoiceDetail>(`/${organizationId}/invoices/${invoiceId}`),
    enabled: Boolean(organizationId && invoiceId),
  });

  const voidMutation = useMutation({
    mutationFn: () => api.post(`/${organizationId}/invoices/${invoiceId}/void`, { reason: voidReason }),
    onSuccess: async () => {
      setVoidOpen(false);
      await queryClient.invalidateQueries();
      toast.success('Invoice voided. It now shows a zero balance and cannot receive payments.');
    },
    onError: (error: unknown) => toast.error(error instanceof ApiError ? error.message : 'Could not void.'),
  });

  const sendMutation = useMutation({
    mutationFn: () =>
      api.post<{ publicToken: string | null; delivery: { status: string; message: string } | null }>(
        `/${organizationId}/invoices/${invoiceId}/send`,
        { sendEmail: true },
      ),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries();
      if (result.publicToken) {
        setPublicUrl(`${window.location.origin}/public/invoices/${result.publicToken}`);
      }
      if (result.delivery?.status === 'sent') {
        toast.success('The email provider accepted the invoice message.');
      } else if (result.delivery) {
        toast.error(result.delivery.message);
      } else {
        toast.success('Invoice marked as sent.');
      }
    },
    onError: (error: unknown) =>
      toast.error(error instanceof ApiError ? error.message : 'Could not send the invoice.'),
  });

  if (detail.isLoading) {
    return (
      <>
        <PageHeader title="Invoice" />
        <Card>
          <div className="space-y-2">
            {[0, 1, 2, 3].map((index) => (
              <div key={index} className="h-5 animate-pulse rounded bg-surface-sunken" />
            ))}
          </div>
        </Card>
      </>
    );
  }

  if (detail.error || !detail.data) {
    return (
      <>
        <PageHeader title="Invoice" />
        <ErrorState message="This invoice could not be loaded." onRetry={() => void detail.refetch()} />
      </>
    );
  }

  const data = detail.data;
  const invoice = data.invoice;
  const currency = invoice.currency;
  const canVoid = canEdit && invoice.status !== 'void' && data.paidMinor === 0;

  return (
    <>
      <PageHeader
        breadcrumb={
          <Link to={`/${organizationId}/invoices`} className="no-underline">
            Invoices
          </Link>
        }
        title={
          <span className="flex flex-wrap items-center gap-3">
            {invoice.invoiceNumber}
            <StatusBadge status={invoice.displayStatus} />
          </span>
        }
        description={`${data.customer?.name ?? 'Customer'} · issued ${formatDate(invoice.issueDate)}${
          invoice.dueDate ? ` · due ${formatDate(invoice.dueDate)}` : ''
        }`}
        actions={
          <>
            <Button
              onClick={() =>
                void apiDownload(`/${organizationId}/invoices/${invoice.id}/pdf`, `${invoice.invoiceNumber}.pdf`).catch(
                  (error: unknown) =>
                    toast.error(error instanceof ApiError ? error.message : 'The PDF could not be generated.'),
                )
              }
            >
              Download PDF
            </Button>
            {canEdit && invoice.status === 'draft' ? (
              <Link to={`/${organizationId}/invoices/${invoice.id}/edit`}>
                <Button>Edit draft</Button>
              </Link>
            ) : null}
            {canSend && invoice.status !== 'void' && invoice.status !== 'paid' ? (
              <Button
                variant="primary"
                loading={sendMutation.isPending}
                onClick={() => sendMutation.mutate()}
              >
                {invoice.sentAt ? 'Resend' : 'Send invoice'}
              </Button>
            ) : null}
            {canRecordPayment && data.balanceMinor > 0 && invoice.status !== 'void' ? (
              <Button variant="primary" onClick={() => setPaymentOpen(true)}>
                Record payment
              </Button>
            ) : null}
            {canVoid ? (
              <Button variant="danger" onClick={() => setVoidOpen(true)}>
                Void
              </Button>
            ) : null}
          </>
        }
      />

      {invoice.status === 'void' ? (
        <div className="mb-4 rounded-lg border border-line bg-surface-sunken px-3 py-2 text-[13px] text-ink-muted">
          This invoice was voided{invoice.voidReason ? `: ${invoice.voidReason}` : ''}. It is kept for the audit trail
          and excluded from every report total.
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card title="Line items">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-[13px]">
                <caption className="sr-only">Line items</caption>
                <thead>
                  <tr className="border-b border-line text-xs uppercase text-ink-muted">
                    <th scope="col" className="py-2 font-semibold">Description</th>
                    <th scope="col" className="py-2 text-right font-semibold">Qty</th>
                    <th scope="col" className="py-2 text-right font-semibold">Unit price</th>
                    <th scope="col" className="py-2 text-right font-semibold">Discount</th>
                    <th scope="col" className="py-2 text-right font-semibold">Tax</th>
                    <th scope="col" className="py-2 text-right font-semibold">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((item) => (
                    <tr key={item.id} className="border-b border-line last:border-0">
                      <td className="py-2 pr-3 text-ink">{item.description}</td>
                      <td className="tabular py-2 text-right text-ink-muted">{item.quantity}</td>
                      <td className="tabular py-2 text-right text-ink">{formatMoney(item.unitPriceMinor, currency)}</td>
                      <td className="tabular py-2 text-right text-ink-muted">
                        {item.discountMinor ? formatMoney(item.discountMinor, currency) : '—'}
                      </td>
                      <td className="tabular py-2 text-right text-ink-muted">
                        {item.taxRateBasisPoints ? `${item.taxRateBasisPoints / 100}%` : '—'}
                      </td>
                      <td className="tabular py-2 text-right font-medium text-ink">
                        {formatMoney(item.lineTotalMinor, currency)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <dl className="mt-4 space-y-1.5 border-t border-line pt-3 text-[13px]">
              <Row label="Subtotal" value={formatMoney(invoice.subtotalMinor, currency)} />
              <Row label="Discount" value={`- ${formatMoney(invoice.discountMinor, currency)}`} />
              <Row label="Tax" value={formatMoney(invoice.taxMinor, currency)} />
              <div className="flex items-baseline justify-between border-t border-line pt-2">
                <dt className="font-semibold text-ink">Total</dt>
                <dd className="tabular text-base font-semibold text-ink">{formatMoney(invoice.totalMinor, currency)}</dd>
              </div>
              <Row label="Paid" value={formatMoney(data.paidMinor, currency)} />
              <div className="flex items-baseline justify-between">
                <dt className="font-semibold text-ink">Balance due</dt>
                <dd className="tabular text-base font-semibold text-ink">
                  {formatMoney(data.balanceMinor, currency)}
                </dd>
              </div>
            </dl>
          </Card>

          <Card
            title="Payment allocation"
            description="Payments are append-only. Refunds and reversals are recorded as separate entries."
          >
            {data.allocations.length === 0 ? (
              <EmptyState
                title="No payments recorded"
                description="Record a manual payment such as a bank transfer, or connect a payment provider."
                action={
                  canRecordPayment && data.balanceMinor > 0 ? (
                    <Button variant="primary" onClick={() => setPaymentOpen(true)}>
                      Record payment
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              <DataTable
                caption="Payments allocated to this invoice"
                rows={data.allocations}
                getRowKey={(row) => row.id}
                columns={[
                  { key: 'paidAt', header: 'Paid on', render: (row) => formatDate(row.paidAt) },
                  {
                    key: 'method',
                    header: 'Method',
                    render: (row) => (
                      <span className="capitalize">
                        {row.paymentMethod.replace(/_/g, ' ')}
                        <span className="ml-1 text-xs text-ink-subtle">
                          ({row.paymentSource === 'manual' ? 'manually recorded' : 'provider confirmed'})
                        </span>
                      </span>
                    ),
                  },
                  {
                    key: 'amount',
                    header: 'Amount',
                    align: 'right',
                    render: (row) => <span className="tabular">{formatMoney(row.amountMinor, currency)}</span>,
                  },
                  { key: 'recorded', header: 'Recorded', hideOnMobile: true, render: (row) => formatDateTime(row.createdAt) },
                ]}
              />
            )}
          </Card>

          {invoice.notes || invoice.terms || invoice.paymentInstructions ? (
            <Card title="Invoice text">
              <div className="space-y-3 text-[13px]">
                {invoice.notes ? <Block label="Notes" value={invoice.notes} /> : null}
                {invoice.terms ? <Block label="Terms" value={invoice.terms} /> : null}
                {invoice.paymentInstructions ? (
                  <Block label="Payment instructions" value={invoice.paymentInstructions} />
                ) : null}
              </div>
            </Card>
          ) : null}
        </div>

        <div className="space-y-4">
          <Card title="Customer">
            {data.customer ? (
              <dl className="space-y-1 text-[13px]">
                <div>
                  <dt className="text-xs text-ink-subtle">Name</dt>
                  <dd className="text-ink">
                    <Link to={`/${organizationId}/customers/${data.customer.id}`} className="no-underline">
                      {data.customer.name}
                    </Link>
                  </dd>
                </div>
                {data.customer.email ? (
                  <div>
                    <dt className="text-xs text-ink-subtle">Email</dt>
                    <dd className="text-ink">{data.customer.email}</dd>
                  </div>
                ) : null}
                {data.customer.phone ? (
                  <div>
                    <dt className="text-xs text-ink-subtle">Phone</dt>
                    <dd className="text-ink">{data.customer.phone}</dd>
                  </div>
                ) : null}
              </dl>
            ) : (
              <p className="text-[13px] text-ink-subtle">Customer record unavailable.</p>
            )}
          </Card>

          <Card title="Public invoice link" description="Unguessable, revocable and rate limited.">
            <div className="space-y-2 text-[13px]">
              {publicUrl ? (
                <>
                  <p className="text-ink-muted">Share this link with the customer. It shows only this invoice.</p>
                  <div className="flex flex-wrap items-center gap-2">
                    <code className="max-w-full truncate rounded bg-surface-sunken px-2 py-1 text-xs">{publicUrl}</code>
                    <CopyButton value={publicUrl} label="Copy link" />
                  </div>
                </>
              ) : (
                <p className="text-ink-muted">
                  {invoice.publicLinkActive
                    ? 'A public link is active for this invoice. Send the invoice again to get a fresh link.'
                    : 'No public link has been created yet. Sending the invoice creates one.'}
                </p>
              )}
            </div>
          </Card>

          <ActivityTimeline
            title="Activity"
            events={data.timeline.map((event) => ({
              id: event.id,
              at: event.createdAt,
              title: event.action.replace(/[._]/g, ' '),
            }))}
          />

          <p className="px-1 text-xs text-ink-subtle">
            Version {invoice.version}. {activeOrganization?.organizationName} keeps a full audit trail for every
            change.
          </p>
        </div>
      </div>

      <RecordPaymentDialog
        open={paymentOpen}
        onClose={() => setPaymentOpen(false)}
        organizationId={organizationId!}
        customerId={data.customer?.id ?? ''}
        currency={currency}
        balanceMinor={data.balanceMinor}
        onRecorded={async () => {
          setPaymentOpen(false);
          await queryClient.invalidateQueries();
          toast.success('Payment recorded. The invoice balance has been recalculated.');
        }}
      />

      <ConfirmDialog
        open={voidOpen}
        onClose={() => setVoidOpen(false)}
        onConfirm={() => voidMutation.mutateAsync().then(() => undefined)}
        title="Void this invoice?"
        confirmLabel="Void invoice"
        summary={
          <div className="space-y-2">
            <p>
              <strong>{invoice.invoiceNumber}</strong> will be marked void. It keeps its number and history but is
              excluded from every report total and can no longer receive payments.
            </p>
            <Field label="Reason" required hint="Recorded in the audit trail.">
              {({ id, describedBy }) => (
                <Textarea
                  id={id}
                  aria-describedby={describedBy}
                  value={voidReason}
                  onChange={(event) => setVoidReason(event.target.value)}
                  rows={3}
                />
              )}
            </Field>
          </div>
        }
      />
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="tabular text-ink">{value}</dd>
    </div>
  );
}

function Block({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-ink-subtle">{label}</p>
      <p className="whitespace-pre-wrap text-ink">{value}</p>
    </div>
  );
}

export function RecordPaymentDialog({
  open,
  onClose,
  organizationId,
  customerId,
  currency,
  balanceMinor,
  onRecorded,
}: {
  open: boolean;
  onClose: () => void;
  organizationId: string;
  customerId: string;
  currency: string;
  balanceMinor?: number;
  onRecorded: () => Promise<void>;
}) {
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<string>('bank_transfer');
  const [paidAt, setPaidAt] = useState(todayIso());
  const [reference, setReference] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    onSuccess: onRecorded,
    onError: (mutationError: unknown) =>
      setError(mutationError instanceof ApiError ? mutationError.message : 'The payment could not be recorded.'),
  });

  const amountMinor = Math.round(Number(amount || 0) * 100);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Record a manual payment"
      description="Only use this for money you have actually received (bank transfer, cash, cheque). CollectFlow never holds funds."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={mutation.isPending}
            disabled={!confirmed || amountMinor <= 0}
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

        <Field label={`Amount (${currency})`} required hint={balanceMinor !== undefined ? `Outstanding on this invoice: ${formatMoney(balanceMinor, currency)}` : undefined}>
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              invalid={invalid}
              inputMode="decimal"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
            />
          )}
        </Field>

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

        <Field label="Reference" hint="Bank reference, cheque number or note. Optional.">
          {({ id, describedBy }) => (
            <Input id={id} aria-describedby={describedBy} value={reference} onChange={(event) => setReference(event.target.value)} />
          )}
        </Field>

        <label className="flex items-start gap-2 text-[13px] text-ink">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-line-strong"
          />
          <span>I confirm the funds were actually received.</span>
        </label>
      </div>
    </Modal>
  );
}