import { useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { SUPPORTED_CURRENCIES, createCustomerSchema, type Paginated } from '@collectflow/shared';

import { DataTable, Pagination } from '../components/patterns';
import { Modal } from '../components/Modal';
import { useToast } from '../components/Toast';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Select,
  Textarea,
} from '../components/ui';
import { api, ApiError } from '../lib/api';
import { formatMoney } from '../lib/format';
import { useSession } from '../lib/session';

interface CustomerRow {
  id: string;
  name: string;
  legalName: string | null;
  email: string | null;
  phone: string | null;
  currency: string | null;
  taxIdentifier: string | null;
  status: 'active' | 'archived';
  outstandingMinor: number;
  invoiceCount: number;
  createdAt: string;
}

export function CustomersPage() {
  const { organizationId } = useParams();
  const [params, setParams] = useSearchParams();
  const { permissions, activeOrganization } = useSession();
  const canManage = permissions.includes('customer.manage');
  const [editorOpen, setEditorOpen] = useState(false);

  const page = Number(params.get('page') ?? '1');
  const status = params.get('status') ?? 'active';
  const q = params.get('q') ?? '';

  const query = useQuery({
    queryKey: ['customers', organizationId, { page, status, q }],
    queryFn: () => {
      const search = new URLSearchParams({ page: String(page), pageSize: '25', status });
      if (q) search.set('q', q);
      return api.get<Paginated<CustomerRow>>(`/${organizationId}/customers?${search.toString()}`);
    },
    enabled: Boolean(organizationId),
  });

  const [search, setSearch] = useState(q);

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
        title="Customers"
        description="Customers with financial history are archived, never deleted."
        actions={
          canManage ? (
            <Button variant="primary" onClick={() => setEditorOpen(true)}>
              New customer
            </Button>
          ) : null
        }
      />

      <Card bodyClassName="p-0">
        <form
          className="flex flex-wrap items-end gap-3 border-b border-line p-4"
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
            update({ q: search, page: 1 });
          }}
        >
          <div className="min-w-[12rem] flex-1">
            <label htmlFor="customer-search" className="mb-1 block text-[13px] font-medium text-ink">
              Search
            </label>
            <Input
              id="customer-search"
              type="search"
              placeholder="Name or email"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <div>
            <label htmlFor="customer-status" className="mb-1 block text-[13px] font-medium text-ink">
              Status
            </label>
            <Select
              id="customer-status"
              value={status}
              onChange={(event) => update({ status: event.target.value, page: 1 })}
            >
              <option value="active">Active</option>
              <option value="archived">Archived</option>
              <option value="all">All</option>
            </Select>
          </div>
          <Button type="submit">Search</Button>
        </form>

        <DataTable
          caption="Customers"
          rows={query.data?.items ?? []}
          getRowKey={(row) => row.id}
          loading={query.isLoading}
          error={query.error ? 'The customer list could not be loaded.' : null}
          onRetry={() => void query.refetch()}
          rowHref={(row) => `/${organizationId}/customers/${row.id}`}
          columns={[
            {
              key: 'name',
              header: 'Customer',
              render: (row) => (
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{row.name}</span>
                  {row.status === 'archived' ? <Badge>Archived</Badge> : null}
                </span>
              ),
            },
            {
              key: 'email',
              header: 'Email',
              hideOnMobile: true,
              render: (row) => row.email ?? '—',
            },
            {
              key: 'invoices',
              header: 'Invoices',
              align: 'right',
              hideOnMobile: true,
              render: (row) => String(row.invoiceCount),
            },
            {
              key: 'outstanding',
              header: 'Outstanding',
              align: 'right',
              render: (row) => (
                <span className="tabular">
                  {row.outstandingMinor > 0
                    ? formatMoney(row.outstandingMinor, row.currency ?? activeOrganization?.baseCurrency ?? 'USD')
                    : '—'}
                </span>
              ),
            },
          ]}
          empty={
            <EmptyState
              title="No customers yet"
              description="Add the people and companies you invoice. Customer email addresses are used to send invoices and reminders."
              action={
                canManage ? (
                  <Button variant="primary" onClick={() => setEditorOpen(true)}>
                    Add a customer
                  </Button>
                ) : undefined
              }
            />
          }
        />

        {query.data ? (
          <Pagination
            page={query.data.page}
            pageSize={query.data.pageSize}
            total={query.data.total}
            onPageChange={(next) => update({ page: next })}
          />
        ) : null}
      </Card>

      <CustomerEditor
        open={editorOpen}
        organizationId={organizationId!}
        baseCurrency={activeOrganization?.baseCurrency ?? 'USD'}
        onClose={() => setEditorOpen(false)}
      />
    </>
  );
}

export function CustomerEditor({
  open,
  onClose,
  organizationId,
  baseCurrency,
  customer,
}: {
  open: boolean;
  onClose: () => void;
  organizationId: string;
  baseCurrency: string;
  customer?: CustomerRow;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState({
    name: customer?.name ?? '',
    legalName: customer?.legalName ?? '',
    email: customer?.email ?? '',
    phone: customer?.phone ?? '',
    taxIdentifier: customer?.taxIdentifier ?? '',
    currency: customer?.currency ?? baseCurrency,
    notes: '',
    line1: '',
    city: '',
    postalCode: '',
    countryCode: '',
  });
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => {
      const payload = {
        name: form.name.trim(),
        legalName: form.legalName.trim() || null,
        email: form.email.trim() || null,
        phone: form.phone.trim() || null,
        taxIdentifier: form.taxIdentifier.trim() || null,
        currency: form.currency || null,
        notes: form.notes.trim() || null,
        billingAddress:
          form.line1 || form.city || form.postalCode || form.countryCode
            ? {
                ...(form.line1 ? { line1: form.line1 } : {}),
                ...(form.city ? { city: form.city } : {}),
                ...(form.postalCode ? { postalCode: form.postalCode } : {}),
                ...(form.countryCode ? { countryCode: form.countryCode.toUpperCase() } : {}),
              }
            : null,
      };
      const parsed = createCustomerSchema.safeParse(payload);
      if (!parsed.success) {
        const fields: Record<string, string[]> = {};
        for (const issue of parsed.error.issues) {
          const key = issue.path.join('.') || 'form';
          (fields[key] ??= []).push(issue.message);
        }
        setErrors(fields);
        return Promise.reject(new ApiError(400, null, 'Please fix the highlighted fields.'));
      }
      return customer
        ? api.patch(`/${organizationId}/customers/${customer.id}`, parsed.data)
        : api.post(`/${organizationId}/customers`, parsed.data);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries();
      toast.success(customer ? 'Customer updated.' : 'Customer created.');
      onClose();
    },
    onError: (mutationError: unknown) =>
      setError(mutationError instanceof ApiError ? mutationError.message : 'Could not save the customer.'),
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={customer ? 'Edit customer' : 'New customer'}
      description="Only an email address and a name are required."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={mutation.isPending}
            onClick={() => {
              setError(null);
              setErrors({});
              mutation.mutate();
            }}
          >
            {customer ? 'Save changes' : 'Create customer'}
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

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Display name" required error={errors.name?.[0]}>
            {({ id, describedBy, invalid }) => (
              <Input id={id} aria-describedby={describedBy} invalid={invalid} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required />
            )}
          </Field>
          <Field label="Legal name" error={errors.legalName?.[0]} hint="Used on invoices when it differs from the display name.">
            {({ id, describedBy, invalid }) => (
              <Input id={id} aria-describedby={describedBy} invalid={invalid} value={form.legalName} onChange={(event) => setForm({ ...form, legalName: event.target.value })} />
            )}
          </Field>
          <Field label="Email" error={errors.email?.[0]} hint="Invoices and reminders go here.">
            {({ id, describedBy, invalid }) => (
              <Input id={id} aria-describedby={describedBy} invalid={invalid} type="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} />
            )}
          </Field>
          <Field label="Phone" error={errors.phone?.[0]} hint="International format, e.g. +1 415 555 0100.">
            {({ id, describedBy, invalid }) => (
              <Input id={id} aria-describedby={describedBy} invalid={invalid} value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} />
            )}
          </Field>
          <Field label="Tax identifier" error={errors.taxIdentifier?.[0]}>
            {({ id, describedBy }) => (
              <Input id={id} aria-describedby={describedBy} value={form.taxIdentifier} onChange={(event) => setForm({ ...form, taxIdentifier: event.target.value })} />
            )}
          </Field>
          <Field label="Preferred currency" error={errors.currency?.[0]}>
            {({ id, describedBy }) => (
              <Select id={id} aria-describedby={describedBy} value={form.currency} onChange={(event) => setForm({ ...form, currency: event.target.value })}>
                {SUPPORTED_CURRENCIES.map((code) => (
                  <option key={code} value={code}>
                    {code}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>

        <fieldset className="rounded-lg border border-line p-3">
          <legend className="px-1 text-[13px] font-medium text-ink">Billing address</legend>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Address line" className="sm:col-span-2">
              {({ id, describedBy }) => (
                <Input id={id} aria-describedby={describedBy} value={form.line1} onChange={(event) => setForm({ ...form, line1: event.target.value })} />
              )}
            </Field>
            <Field label="City">
              {({ id, describedBy }) => (
                <Input id={id} aria-describedby={describedBy} value={form.city} onChange={(event) => setForm({ ...form, city: event.target.value })} />
              )}
            </Field>
            <Field label="Postal code">
              {({ id, describedBy }) => (
                <Input id={id} aria-describedby={describedBy} value={form.postalCode} onChange={(event) => setForm({ ...form, postalCode: event.target.value })} />
              )}
            </Field>
            <Field label="Country code">
              {({ id, describedBy }) => (
                <Input id={id} aria-describedby={describedBy} maxLength={2} value={form.countryCode} onChange={(event) => setForm({ ...form, countryCode: event.target.value })} />
              )}
            </Field>
          </div>
        </fieldset>

        <Field label="Internal notes" hint="Never shown to the customer.">
          {({ id, describedBy }) => (
            <Textarea id={id} aria-describedby={describedBy} value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} />
          )}
        </Field>

        {customer ? (
          <Checkbox
            label="Archived"
            hint="Archiving hides the customer from pickers but keeps invoices and payments intact."
            checked={customer.status === 'archived'}
            onChange={(event) => {
              void api
                .post(`/${organizationId}/customers/${customer.id}/archive`, { archived: event.target.checked })
                .then(async () => {
                  await queryClient.invalidateQueries();
                  toast.success(event.target.checked ? 'Customer archived.' : 'Customer restored.');
                })
                .catch((error: unknown) =>
                  toast.error(error instanceof ApiError ? error.message : 'Could not update the customer.'),
                );
            }}
          />
        ) : null}
      </div>
    </Modal>
  );
}