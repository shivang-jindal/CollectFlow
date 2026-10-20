import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { calculateInvoiceTotals, formatMinorAsDecimal, SUPPORTED_CURRENCIES as CURRENCIES } from '@collectflow/shared';

import { Button, Card, Checkbox, Field, Input, PageHeader, Select, Textarea } from '../components/ui';
import { useToast } from '../components/Toast';
import { api, ApiError } from '../lib/api';
import { addDaysIso, formatMoney, todayIso } from '../lib/format';
import { useSession } from '../lib/session';

interface CustomerOption {
  id: string;
  name: string;
  email: string | null;
  currency: string | null;
}

interface LineItemDraft {
  key: string;
  description: string;
  quantity: string;
  unitPrice: string;
  discountMinor: number;
  taxRateBasisPoints: number;
}

interface OrganizationSettingsResponse {
  settings: {
    defaultDueDays: number;
    defaultTerms: string | null;
    defaultNotes: string | null;
    defaultPaymentInstructions: string | null;
    taxLabel: string;
    taxRateBasisPoints: number;
    allowIssueDateAfterDueDate: boolean;
  } | null;
}

const newLine = (): LineItemDraft => ({
  key: Math.random().toString(36).slice(2),
  description: '',
  quantity: '1',
  unitPrice: '0.00',
  discountMinor: 0,
  taxRateBasisPoints: 0,
});

export function InvoiceEditorPage() {
  const { organizationId, invoiceId } = useParams();
  const isEdit = Boolean(invoiceId);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { activeOrganization } = useSession();

  const baseCurrency = activeOrganization?.baseCurrency ?? 'USD';
  const [currency, setCurrency] = useState(baseCurrency);
  const [customerId, setCustomerId] = useState('');
  const [issueDate, setIssueDate] = useState(todayIso());
  const [dueDate, setDueDate] = useState(addDaysIso(todayIso(), 14));
  const [discount, setDiscount] = useState('0.00');
  const [notes, setNotes] = useState('');
  const [terms, setTerms] = useState('');
  const [paymentInstructions, setPaymentInstructions] = useState('');
  const [sendNow, setSendNow] = useState(false);
  const [items, setItems] = useState<LineItemDraft[]>([newLine()]);
  const [formError, setFormError] = useState<string | null>(null);

  const settings = useQuery({
    queryKey: ['invoice-settings', organizationId],
    queryFn: () => api.get<OrganizationSettingsResponse>(`/${organizationId}/settings/invoices`),
    enabled: Boolean(organizationId),
  });

  const customers = useQuery({
    queryKey: ['customer-options', organizationId],
    queryFn: () => api.get<{ options: CustomerOption[] }>(`/${organizationId}/customers/options?limit=50`),
    enabled: Boolean(organizationId),
  });

  const existing = useQuery({
    queryKey: ['invoice', organizationId, invoiceId],
    queryFn: () => api.get<InvoiceDetail>(`/${organizationId}/invoices/${invoiceId}`),
    enabled: isEdit,
  });

  // Prefill once from the server - never trust browser totals.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    if (hydrated) return;
    if (isEdit) {
      const data = existing.data;
      if (!data) return;
      setCustomerId(data.invoice.customerId);
      setCurrency(data.invoice.currency);
      setIssueDate(data.invoice.issueDate);
      setDueDate(data.invoice.dueDate ?? '');
      setDiscount(formatMinorAsDecimal(data.invoice.discountMinor, data.invoice.currency));
      setNotes(data.invoice.notes ?? '');
      setTerms(data.invoice.terms ?? '');
      setPaymentInstructions(data.invoice.paymentInstructions ?? '');
      setItems(
        data.items.map((item) => ({
          key: item.id,
          description: item.description,
          quantity: item.quantity,
          unitPrice: formatMinorAsDecimal(item.unitPriceMinor, data.invoice.currency),
          discountMinor: item.discountMinor,
          taxRateBasisPoints: item.taxRateBasisPoints,
        })),
      );
      setHydrated(true);
      return;
    }
    const organizationSettings = settings.data?.settings;
    if (!organizationSettings) return;
    setCurrency(baseCurrency);
    setDueDate(addDaysIso(todayIso(), organizationSettings.defaultDueDays));
    setTerms(organizationSettings.defaultTerms ?? '');
    setNotes(organizationSettings.defaultNotes ?? '');
    setPaymentInstructions(organizationSettings.defaultPaymentInstructions ?? '');
    setHydrated(true);
  }, [hydrated, isEdit, existing.data, settings.data, baseCurrency]);

  const organizationSettings = settings.data?.settings;

  const calculated = useMemo(() => {
    try {
      return calculateInvoiceTotals(
        items.map((item) => ({
          description: item.description || 'Line item',
          quantity: item.quantity || '0',
          unitPriceMinor: Math.round(Number(item.unitPrice || 0) * 100),
          discountMinor: item.discountMinor,
          taxRateBasisPoints: item.taxRateBasisPoints,
        })),
        Math.round(Number(discount || 0) * 100),
      );
    } catch {
      return null;
    }
  }, [items, discount]);

  const save = useMutation({
    mutationFn: () => {
      const payloadItems = items.map((item) => ({
        description: item.description.trim(),
        quantity: item.quantity.trim(),
        unitPriceMinor: Math.round(Number(item.unitPrice) * 100),
        discountMinor: item.discountMinor,
        taxRateBasisPoints: item.taxRateBasisPoints,
      }));
      const body = {
        customerId,
        issueDate,
        dueDate: dueDate || null,
        currency,
        items: payloadItems,
        discountMinor: Math.round(Number(discount || 0) * 100),
        notes: notes.trim() || null,
        terms: terms.trim() || null,
        paymentInstructions: paymentInstructions.trim() || null,
        saveAsDraft: !sendNow,
      };
      return isEdit
        ? api.patch<{ invoice: { id: string } }>(`/${organizationId}/invoices/${invoiceId}`, body)
        : api.post<{ invoice: { id: string } }>(`/${organizationId}/invoices`, body);
    },
    onSuccess: async (result) => {
      await queryClient.invalidateQueries();
      toast.success(isEdit ? 'Invoice updated.' : sendNow ? 'Invoice created and sent.' : 'Draft saved.');
      navigate(`/${organizationId}/invoices/${result.invoice.id}`);
    },
    onError: (error: unknown) => {
      setFormError(error instanceof ApiError ? error.message : 'The invoice could not be saved.');
    },
  });

  const updateItem = (key: string, patch: Partial<LineItemDraft>) =>
    setItems((current) => current.map((item) => (item.key === key ? { ...item, ...patch } : item)));

  const editingLocked = existing.data ? existing.data.invoice.status !== 'draft' : false;

  return (
    <>
      <PageHeader
        title={isEdit ? 'Edit invoice' : 'New invoice'}
        breadcrumb={
          isEdit ? (
            <button type="button" className="no-underline" onClick={() => navigate(-1)}>
              Back to invoice
            </button>
          ) : undefined
        }
        description="Totals are recalculated on the server when you save. The values below are a preview."
      />

      {editingLocked ? (
        <div className="mb-4 rounded-lg border border-warning/30 bg-warning-soft px-3 py-2 text-[13px] text-[color:var(--color-warning)]">
          This invoice has already been sent, so its financial values cannot be edited. Void it and issue a
          corrected invoice instead - the original stays in the audit trail.
        </div>
      ) : null}

      <form
        className="grid gap-4 lg:grid-cols-3"
        onSubmit={(event) => {
          event.preventDefault();
          setFormError(null);
          save.mutate();
        }}
        noValidate
      >
        <div className="space-y-4 lg:col-span-2">
          <Card title="Invoice details">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Customer" required className="sm:col-span-2">
                {({ id, describedBy, invalid }) => (
                  <Select
                    id={id}
                    aria-describedby={describedBy}
                    invalid={invalid}
                    required
                    value={customerId}
                    onChange={(event) => setCustomerId(event.target.value)}
                    disabled={editingLocked}
                  >
                    <option value="">Select a customer…</option>
                    {(customers.data?.options ?? []).map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.name}
                        {option.email ? ` · ${option.email}` : ''}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>

              <Field label="Issue date" required>
                {({ id, describedBy, invalid }) => (
                  <Input
                    id={id}
                    aria-describedby={describedBy}
                    invalid={invalid}
                    type="date"
                    required
                    value={issueDate}
                    onChange={(event) => setIssueDate(event.target.value)}
                    disabled={editingLocked}
                  />
                )}
              </Field>

              <Field
                label="Due date"
                error={dueDate && dueDate < issueDate ? 'The due date cannot be before the issue date.' : undefined}
              >
                {({ id, describedBy, invalid }) => (
                  <Input
                    id={id}
                    aria-describedby={describedBy}
                    invalid={invalid || (dueDate !== '' && dueDate < issueDate)}
                    type="date"
                    value={dueDate}
                    onChange={(event) => setDueDate(event.target.value)}
                    disabled={editingLocked}
                  />
                )}
              </Field>

              <Field label="Currency" required hint="Amounts are stored per invoice; different currencies are never added together.">
                {({ id, describedBy, invalid }) => (
                  <Select
                    id={id}
                    aria-describedby={describedBy}
                    invalid={invalid}
                    value={currency}
                    onChange={(event) => setCurrency(event.target.value)}
                    disabled={editingLocked}
                  >
                    {CURRENCIES.map((code) => (
                      <option key={code} value={code}>
                        {code}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>

              <Field label="Invoice discount" hint="Applied proportionally across the lines.">
                {({ id, describedBy, invalid }) => (
                  <Input
                    id={id}
                    aria-describedby={describedBy}
                    invalid={invalid}
                    inputMode="decimal"
                    value={discount}
                    onChange={(event) => setDiscount(event.target.value)}
                    disabled={editingLocked}
                  />
                )}
              </Field>
            </div>
          </Card>

          <Card
            title="Line items"
            description="Quantity accepts up to 4 decimals. Prices are entered in major units and stored as minor units."
            actions={
              <Button size="sm" onClick={() => setItems((current) => [...current, newLine()])} disabled={editingLocked}>
                Add line
              </Button>
            }
          >
            <div className="space-y-3">
              {items.map((item, index) => (
                <div key={item.key} className="grid gap-3 rounded-lg border border-line p-3 sm:grid-cols-12">
                  <div className="sm:col-span-6">
                    <label htmlFor={`item-${item.key}-description`} className="mb-1 block text-[13px] font-medium text-ink">
                      Description
                    </label>
                    <Input
                      id={`item-${item.key}-description`}
                      value={item.description}
                      onChange={(event) => updateItem(item.key, { description: event.target.value })}
                      required
                      disabled={editingLocked}
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <label htmlFor={`item-${item.key}-quantity`} className="mb-1 block text-[13px] font-medium text-ink">
                      Qty
                    </label>
                    <Input
                      id={`item-${item.key}-quantity`}
                      value={item.quantity}
                      onChange={(event) => updateItem(item.key, { quantity: event.target.value })}
                      required
                      disabled={editingLocked}
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <label htmlFor={`item-${item.key}-price`} className="mb-1 block text-[13px] font-medium text-ink">
                      Unit price
                    </label>
                    <Input
                      id={`item-${item.key}-price`}
                      inputMode="decimal"
                      value={item.unitPrice}
                      onChange={(event) => updateItem(item.key, { unitPrice: event.target.value })}
                      required
                      disabled={editingLocked}
                    />
                  </div>
                  <div className="sm:col-span-1">
                    <label htmlFor={`item-${item.key}-tax`} className="mb-1 block text-[13px] font-medium text-ink">
                      Tax %
                    </label>
                    <Input
                      id={`item-${item.key}-tax`}
                      inputMode="numeric"
                      value={item.taxRateBasisPoints / 100}
                      onChange={(event) =>
                        updateItem(item.key, {
                          taxRateBasisPoints: Math.round(Number(event.target.value || 0) * 100),
                        })
                      }
                      disabled={editingLocked}
                    />
                  </div>
                  <div className="flex items-end sm:col-span-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Remove line ${index + 1}`}
                      disabled={items.length === 1 || editingLocked}
                      onClick={() => setItems((current) => current.filter((row) => row.key !== item.key))}
                    >
                      Remove
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </Card>

          <Card title="Notes, terms and payment instructions">
            <div className="grid gap-4">
              <Field label="Notes shown on the invoice">
                {({ id, describedBy }) => (
                  <Textarea
                    id={id}
                    aria-describedby={describedBy}
                    value={notes}
                    onChange={(event) => setNotes(event.target.value)}
                    disabled={editingLocked}
                  />
                )}
              </Field>
              <Field label="Payment terms">
                {({ id, describedBy }) => (
                  <Textarea
                    id={id}
                    aria-describedby={describedBy}
                    value={terms}
                    onChange={(event) => setTerms(event.target.value)}
                    disabled={editingLocked}
                  />
                )}
              </Field>
              <Field
                label="Payment instructions"
                hint="Bank details are shown to the customer on the invoice and public page."
              >
                {({ id, describedBy }) => (
                  <Textarea
                    id={id}
                    aria-describedby={describedBy}
                    value={paymentInstructions}
                    onChange={(event) => setPaymentInstructions(event.target.value)}
                    disabled={editingLocked}
                  />
                )}
              </Field>
            </div>
          </Card>
        </div>

        <div className="space-y-4">
          <Card title="Preview" description="Recalculated by the server on save.">
            {calculated ? (
              <dl className="space-y-2 text-[13px]">
                <Row label="Subtotal" value={formatMoney(calculated.subtotalMinor, currency)} />
                <Row label="Discount" value={`- ${formatMoney(calculated.discountMinor, currency)}`} />
                <Row
                  label={organizationSettings?.taxLabel ?? 'Tax'}
                  value={formatMoney(calculated.taxMinor, currency)}
                />
                <div className="mt-2 flex items-baseline justify-between border-t border-line pt-2">
                  <dt className="font-semibold text-ink">Total</dt>
                  <dd className="tabular text-lg font-semibold text-ink">
                    {formatMoney(calculated.totalMinor, currency)}
                  </dd>
                </div>
              </dl>
            ) : (
              <p className="text-[13px] text-ink-subtle">
                Enter valid quantities and prices to see a preview.
              </p>
            )}
            <p className="mt-3 text-xs text-ink-subtle">
              Tax is recorded exactly as entered. CollectFlow does not guarantee tax compliance.
            </p>
          </Card>

          <Card title="Save">
            <div className="space-y-3">
              {formError ? (
                <p role="alert" className="rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-[13px] text-[color:var(--color-danger)]">
                  {formError}
                </p>
              ) : null}

              {!isEdit ? (
                <Checkbox
                  label="Send the invoice now"
                  hint="Queues an email to the customer. You still need a configured email provider."
                  checked={sendNow}
                  disabled={editingLocked}
                  onChange={(event) => setSendNow(event.target.checked)}
                />
              ) : null}

              <div className="flex flex-col gap-2">
                <Button
                  type="submit"
                  variant="primary"
                  loading={save.isPending}
                  disabled={editingLocked || !customerId || items.length === 0}
                  className="w-full"
                >
                  {isEdit ? 'Save changes' : sendNow ? 'Create and send' : 'Save draft'}
                </Button>
                <Button variant="ghost" className="w-full" onClick={() => navigate(-1)}>
                  Cancel
                </Button>
              </div>
            </div>
          </Card>
        </div>
      </form>
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

interface InvoiceDetail {
  invoice: {
    id: string;
    customerId: string;
    currency: string;
    issueDate: string;
    dueDate: string | null;
    notes: string | null;
    terms: string | null;
    paymentInstructions: string | null;
    discountMinor: number;
    status: string;
  };
  items: Array<{
    id: string;
    description: string;
    quantity: string;
    unitPriceMinor: number;
    discountMinor: number;
    taxRateBasisPoints: number;
    lineTotalMinor: number;
  }>;
}