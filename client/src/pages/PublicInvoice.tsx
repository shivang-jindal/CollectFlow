/**
 * Public invoice view.
 *
 * Unauthenticated, read-only, and limited to the fields a customer needs. It is
 * served from the API through an unguessable, revocable, rate-limited token.
 */

import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';

import { Badge, Card, ErrorState } from '../components/ui';
import { api } from '../lib/api';
import { formatDate } from '../lib/format';

interface PublicInvoice {
  organization: { name: string; address: string[] };
  customer: { name: string };
  invoice: {
    number: string;
    issueDate: string;
    dueDate: string | null;
    currency: string;
    status: string;
    subtotal: string;
    discount: string;
    tax: string;
    total: string;
    paid: string;
    balance: string;
    notes: string | null;
    terms: string | null;
    paymentInstructions: string | null;
  };
  items: Array<{ description: string; quantity: string; unitPrice: string; amount: string }>;
  onlinePayment: { available: boolean; reason: string };
}

export function PublicInvoicePage() {
  const { token } = useParams();

  const query = useQuery({
    queryKey: ['public-invoice', token],
    queryFn: () => api.get<PublicInvoice>(`/public/invoices/${token}`),
    enabled: Boolean(token),
    retry: false,
  });

  if (query.isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center" role="status">
        <span className="text-sm text-ink-muted">Loading invoice…</span>
      </div>
    );
  }

  if (query.error || !query.data) {
    return (
      <div className="flex min-h-screen items-center justify-center px-4">
        <Card className="w-full max-w-md">
          <ErrorState
            title="This invoice link is not available"
            message="The link may have been revoked, or it may have expired. Ask the business that sent it for a new link."
          />
        </Card>
      </div>
    );
  }

  const { organization, invoice, items, onlinePayment } = query.data;

  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[13px] text-ink-muted">Invoice from</p>
          <h1 className="text-xl">{organization.name}</h1>
          {organization.address.length > 0 ? (
            <p className="text-[13px] text-ink-muted">{organization.address.join(', ')}</p>
          ) : null}
        </div>
        <div className="text-right">
          <p className="text-[13px] text-ink-muted">Invoice</p>
          <p className="text-lg font-semibold text-ink">{invoice.number}</p>
          <div className="mt-1">
            <Badge tone={invoice.status === 'paid' ? 'success' : invoice.status === 'overdue' ? 'danger' : 'info'}>
              {invoice.status.replace(/_/g, ' ')}
            </Badge>
          </div>
        </div>
      </header>

      <Card>
        <dl className="grid gap-3 text-[13px] sm:grid-cols-3">
          <div>
            <dt className="text-xs text-ink-subtle">Billed to</dt>
            <dd className="text-ink">{query.data.customer.name}</dd>
          </div>
          <div>
            <dt className="text-xs text-ink-subtle">Issue date</dt>
            <dd className="text-ink">{formatDate(invoice.issueDate)}</dd>
          </div>
          <div>
            <dt className="text-xs text-ink-subtle">Due date</dt>
            <dd className="text-ink">{formatDate(invoice.dueDate)}</dd>
          </div>
        </dl>

        <div className="mt-5 overflow-x-auto">
          <table className="w-full text-left text-[13px]">
            <caption className="sr-only">Invoice line items</caption>
            <thead>
              <tr className="border-b border-line text-xs uppercase text-ink-muted">
                <th scope="col" className="py-2 font-semibold">Description</th>
                <th scope="col" className="py-2 text-right font-semibold">Qty</th>
                <th scope="col" className="py-2 text-right font-semibold">Unit price</th>
                <th scope="col" className="py-2 text-right font-semibold">Amount</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item, index) => (
                <tr key={`${item.description}-${index}`} className="border-b border-line last:border-0">
                  <td className="py-2 pr-3">{item.description}</td>
                  <td className="tabular py-2 text-right text-ink-muted">{item.quantity}</td>
                  <td className="tabular py-2 text-right">{item.unitPrice}</td>
                  <td className="tabular py-2 text-right font-medium">{item.amount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <dl className="mt-4 space-y-1.5 border-t border-line pt-3 text-[13px]">
          <Row label="Subtotal" value={`${invoice.subtotal} ${invoice.currency}`} />
          <Row label="Discount" value={`- ${invoice.discount} ${invoice.currency}`} />
          <Row label="Tax" value={`${invoice.tax} ${invoice.currency}`} />
          <Row label="Total" value={`${invoice.total} ${invoice.currency}`} strong />
          <Row label="Paid" value={`${invoice.paid} ${invoice.currency}`} />
          <Row label="Balance due" value={`${invoice.balance} ${invoice.currency}`} strong />
        </dl>

        {invoice.paymentInstructions ? (
          <div className="mt-5 rounded-lg border border-line bg-surface-sunken p-3">
            <h2 className="text-[13px] font-medium">Payment instructions</h2>
            <p className="mt-1 whitespace-pre-wrap text-[13px] text-ink-muted">{invoice.paymentInstructions}</p>
          </div>
        ) : null}

        {invoice.notes ? (
          <div className="mt-4">
            <h2 className="text-[13px] font-medium">Notes</h2>
            <p className="whitespace-pre-wrap text-[13px] text-ink-muted">{invoice.notes}</p>
          </div>
        ) : null}

        {invoice.terms ? (
          <div className="mt-4">
            <h2 className="text-[13px] font-medium">Terms</h2>
            <p className="whitespace-pre-wrap text-[13px] text-ink-muted">{invoice.terms}</p>
          </div>
        ) : null}
      </Card>

      <div className="mt-4 rounded-lg border border-line bg-white px-4 py-3 text-[13px] text-ink-muted">
        {onlinePayment.available ? null : onlinePayment.reason}
      </div>

      <p className="mt-6 text-center text-xs text-ink-subtle">
        This page was generated by CollectFlow. It shows only this invoice.
      </p>
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`flex items-baseline justify-between ${strong ? 'border-t border-line pt-1.5 font-semibold text-ink' : ''}`}>
      <dt className={strong ? '' : 'text-ink-muted'}>{label}</dt>
      <dd className="tabular">{value}</dd>
    </div>
  );
}