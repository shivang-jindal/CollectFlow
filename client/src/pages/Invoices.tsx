import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';

import type { Paginated } from '@collectflow/shared';

import { DataTable, Pagination, StatusBadge } from '../components/patterns';
import { Button, Card, EmptyState, Input, PageHeader, Select } from '../components/ui';
import { api } from '../lib/api';
import { formatDate, formatMoney } from '../lib/format';
import { useSession } from '../lib/session';

interface InvoiceRow {
  id: string;
  invoiceNumber: string;
  customerId: string;
  customerName: string;
  displayStatus: string;
  status: string;
  issueDate: string;
  dueDate: string | null;
  currency: string;
  totalMinor: number;
  paidMinor: number;
  balanceMinor: number;
}

const STATUSES = [
  { value: 'all', label: 'All statuses' },
  { value: 'draft', label: 'Draft' },
  { value: 'sent', label: 'Sent' },
  { value: 'partially_paid', label: 'Partially paid' },
  { value: 'paid', label: 'Paid' },
  { value: 'overdue', label: 'Overdue' },
  { value: 'void', label: 'Void' },
];

export function InvoicesPage() {
  const { organizationId } = useParams();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const { permissions } = useSession();

  const [search, setSearch] = useState(params.get('q') ?? '');
  const page = Number(params.get('page') ?? '1');
  const status = params.get('status') ?? 'all';
  const sort = params.get('sort') ?? 'issue_date';
  const order = params.get('order') ?? 'desc';

  const query = useQuery({
    queryKey: ['invoices', organizationId, { q: params.get('q'), status, page, sort, order }],
    queryFn: () => {
      const search = new URLSearchParams({
        page: String(page),
        pageSize: '25',
        status,
        sort,
        order,
      });
      const q = params.get('q');
      if (q) search.set('q', q);
      return api.get<Paginated<InvoiceRow>>(`/${organizationId}/invoices?${search.toString()}`);
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

  const canCreate = permissions.includes('invoice.create');

  return (
    <>
      <PageHeader
        title="Invoices"
        description="Search by invoice number or customer. Amounts are shown per currency."
        actions={
          canCreate ? (
            <Link to={`/${organizationId}/invoices/new`}>
              <Button variant="primary">New invoice</Button>
            </Link>
          ) : null
        }
      />

      <Card bodyClassName="p-0">
        <form
          className="flex flex-wrap items-end gap-3 border-b border-line p-4"
          onSubmit={(event) => {
            event.preventDefault();
            update({ q: search, page: 1 });
          }}
          role="search"
        >
          <div className="min-w-[12rem] flex-1">
            <label htmlFor="invoice-search" className="mb-1 block text-[13px] font-medium text-ink">
              Search
            </label>
            <Input
              id="invoice-search"
              type="search"
              placeholder="Invoice number or customer"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <div>
            <label htmlFor="invoice-status" className="mb-1 block text-[13px] font-medium text-ink">
              Status
            </label>
            <Select
              id="invoice-status"
              value={status}
              onChange={(event) => update({ status: event.target.value, page: 1 })}
            >
              {STATUSES.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </div>
          <Button type="submit" variant="secondary">
            Search
          </Button>
          {(params.get('q') || status !== 'all') && (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setSearch('');
                setParams(new URLSearchParams(), { replace: true });
              }}
            >
              Reset
            </Button>
          )}
        </form>

        <DataTable
          caption="Invoices"
          rows={query.data?.items ?? []}
          getRowKey={(row) => row.id}
          loading={query.isLoading}
          error={query.error ? 'The invoice list could not be loaded.' : null}
          onRetry={() => void query.refetch()}
          rowHref={(row) => `/${organizationId}/invoices/${row.id}`}
          sort={{ key: sort, order: order === 'asc' ? 'asc' : 'desc' }}
          onSortChange={(key) => update({ sort: key, order: order === 'asc' ? 'desc' : 'asc' })}
          columns={[
            {
              key: 'invoice_number',
              header: 'Invoice',
              sortable: true,
              render: (row) => <span className="font-medium">{row.invoiceNumber}</span>,
            },
            {
              key: 'customer',
              header: 'Customer',
              render: (row) => (
                <Link
                  to={`/${organizationId}/customers/${row.customerId}`}
                  onClick={(event) => event.stopPropagation()}
                  className="no-underline"
                >
                  {row.customerName}
                </Link>
              ),
            },
            {
              key: 'issue_date',
              header: 'Issued',
              sortable: true,
              hideOnMobile: true,
              render: (row) => formatDate(row.issueDate),
            },
            {
              key: 'due_date',
              header: 'Due',
              sortable: true,
              render: (row) => formatDate(row.dueDate),
            },
            {
              key: 'total_minor',
              header: 'Total',
              align: 'right',
              sortable: true,
              hideOnMobile: true,
              render: (row) => <span className="tabular">{formatMoney(row.totalMinor, row.currency)}</span>,
            },
            {
              key: 'balance_minor',
              header: 'Balance',
              align: 'right',
              sortable: true,
              render: (row) => (
                <span className="tabular font-medium">{formatMoney(row.balanceMinor, row.currency)}</span>
              ),
            },
            {
              key: 'status',
              header: 'Status',
              render: (row) => <StatusBadge status={row.displayStatus} />,
            },
          ]}
          empty={
            params.get('q') || status !== 'all' ? (
              <EmptyState
                title="No invoices match these filters"
                description="Try a different search term or clear the status filter."
                action={
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setSearch('');
                      setParams(new URLSearchParams(), { replace: true });
                    }}
                  >
                    Clear filters
                  </Button>
                }
              />
            ) : (
              <EmptyState
                title="No invoices yet"
                description="Create your first invoice to start tracking what has been paid."
                action={
                  canCreate ? (
                    <Button variant="primary" onClick={() => navigate(`/${organizationId}/invoices/new`)}>
                      New invoice
                    </Button>
                  ) : undefined
                }
              />
            )
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
    </>
  );
}