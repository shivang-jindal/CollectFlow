import { useState } from 'react';
import { NavLink, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { Paginated } from '@collectflow/shared';

import { DataTable, Pagination } from '../components/patterns';
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
import { formatDateTime } from '../lib/format';
import { useSession } from '../lib/session';

interface OrganizationSettings {
  organization: {
    id: string;
    name: string;
    baseCurrency: string;
    timezone: string;
    countryCode: string;
    logoUrl: string | null;
    addressLine1: string | null;
    city: string | null;
    postalCode: string | null;
    taxIdentifier: string | null;
  };
  role: string;
  permissions: string[];
  settings: {
    invoicePrefix: string;
    nextNumber: number;
    defaultDueDays: number;
    defaultTerms: string | null;
    defaultNotes: string | null;
    defaultPaymentInstructions: string | null;
    taxLabel: string;
    taxRateBasisPoints: number;
    allowManualPayments: boolean;
    remindersPaused: boolean;
    quietHoursStart: string | null;
    quietHoursEnd: string | null;
  } | null;
}

interface MemberRow {
  id: string;
  userId: string;
  email: string;
  displayName: string;
  role: string;
  status: string;
  createdAt: string;
}

const TABS = [
  { path: 'organization', label: 'Organization' },
  { path: 'invoices', label: 'Invoice settings' },
  { path: 'members', label: 'Members' },
  { path: 'audit', label: 'Audit log' },
] as const;

export function SettingsPage() {
  const { organizationId } = useParams();
  const query = useQuery({
    queryKey: ['organization', organizationId],
    queryFn: () => api.get<OrganizationSettings>(`/${organizationId}`),
    enabled: Boolean(organizationId),
  });

  return (
    <>
      <PageHeader
        title="Settings"
        description="Workspace profile, invoice defaults, member roles and the full audit trail."
      />

      <nav className="mb-4 flex flex-wrap gap-1 rounded-lg border border-line bg-white p-1" aria-label="Settings sections">
        {TABS.map((tab) => (
          <NavLink
            key={tab.path}
            to={`/${organizationId}/settings/${tab.path}`}
            className={({ isActive }) =>
              `rounded-md px-3 py-1.5 text-[13px] font-medium no-underline ${
                isActive ? 'bg-brand-600 text-white' : 'text-ink-muted hover:bg-surface-sunken'
              }`
            }
          >
            {tab.label}
          </NavLink>
        ))}
      </nav>

      {!query.data ? (
        <Card>
          <div className="h-40 animate-pulse rounded bg-surface-sunken" />
        </Card>
      ) : (
        <Routes>
          <Route index element={<NavigateTo path="organization" organizationId={organizationId!} />} />
          <Route path="organization" element={<OrganizationTab data={query.data} />} />
          <Route path="invoices" element={<InvoiceSettingsTab data={query.data} />} />
          <Route path="members" element={<MembersTab />} />
          <Route path="audit" element={<AuditTab />} />
          <Route path="*" element={<EmptyState title="Unknown settings section" description="Pick a section from the tabs above." />} />
        </Routes>
      )}
    </>
  );
}

function NavigateTo({ path, organizationId }: { path: string; organizationId: string }) {
  const navigate = useNavigate();
  return (
    <Button onClick={() => navigate(`/${organizationId}/settings/${path}`)}>Open {path}</Button>
  );
}

/* -------------------------------------------------------------------------- */

function OrganizationTab({ data }: { data: OrganizationSettings }) {
  const { organizationId } = useParams();
  const queryClient = useQueryClient();
  const toast = useToast();
  const canManage = data.permissions.includes('settings.manage');
  const [form, setForm] = useState({
    name: data.organization.name,
    taxIdentifier: data.organization.taxIdentifier ?? '',
    addressLine1: data.organization.addressLine1 ?? '',
    city: data.organization.city ?? '',
    postalCode: data.organization.postalCode ?? '',
  });
  const [error, setError] = useState<string | null>(null);

  const dirty =
    form.name !== data.organization.name ||
    form.taxIdentifier !== (data.organization.taxIdentifier ?? '') ||
    form.addressLine1 !== (data.organization.addressLine1 ?? '') ||
    form.city !== (data.organization.city ?? '') ||
    form.postalCode !== (data.organization.postalCode ?? '');

  const save = useMutation({
    mutationFn: () =>
      api.patch(`/${organizationId}`, {
        name: form.name.trim(),
        taxIdentifier: form.taxIdentifier.trim() || null,
        addressLine1: form.addressLine1.trim() || null,
        city: form.city.trim() || null,
        postalCode: form.postalCode.trim() || null,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries();
      toast.success('Organization profile saved.');
    },
    onError: (mutationError: unknown) =>
      setError(mutationError instanceof ApiError ? mutationError.message : 'Could not save the profile.'),
  });

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card title="Business profile" description="Used on invoices, PDFs and the public invoice page." className="lg:col-span-2">
        <div className="space-y-4">
          {error ? (
            <p role="alert" className="rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-[13px] text-[color:var(--color-danger)]">
              {error}
            </p>
          ) : null}

          <Field label="Business name" required>
            {({ id, describedBy }) => (
              <Input id={id} aria-describedby={describedBy} value={form.name} disabled={!canManage} onChange={(event) => setForm({ ...form, name: event.target.value })} />
            )}
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Tax identifier" hint="Recorded as entered on invoices.">
              {({ id, describedBy }) => (
                <Input id={id} aria-describedby={describedBy} value={form.taxIdentifier} disabled={!canManage} onChange={(event) => setForm({ ...form, taxIdentifier: event.target.value })} />
              )}
            </Field>
            <Field label="Country" hint="Set at workspace creation.">
              {({ id }) => <Input id={id} value={data.organization.countryCode} disabled readOnly />}
            </Field>
            <Field label="Address line">
              {({ id, describedBy }) => (
                <Input id={id} aria-describedby={describedBy} value={form.addressLine1} disabled={!canManage} onChange={(event) => setForm({ ...form, addressLine1: event.target.value })} />
              )}
            </Field>
            <Field label="City">
              {({ id, describedBy }) => (
                <Input id={id} aria-describedby={describedBy} value={form.city} disabled={!canManage} onChange={(event) => setForm({ ...form, city: event.target.value })} />
              )}
            </Field>
            <Field label="Postal code">
              {({ id, describedBy }) => (
                <Input id={id} aria-describedby={describedBy} value={form.postalCode} disabled={!canManage} onChange={(event) => setForm({ ...form, postalCode: event.target.value })} />
              )}
            </Field>
            <Field label="Base currency" hint="Changing currency later affects new invoices only.">
              {({ id }) => <Input id={id} value={data.organization.baseCurrency} disabled readOnly />}
            </Field>
          </div>

          <div className="flex gap-2">
            <Button variant="primary" disabled={!dirty || !canManage || save.isPending} loading={save.isPending} onClick={() => save.mutate()}>
              Save changes
            </Button>
            <Button
              variant="ghost"
              disabled={!dirty}
              onClick={() =>
                setForm({
                  name: data.organization.name,
                  taxIdentifier: data.organization.taxIdentifier ?? '',
                  addressLine1: data.organization.addressLine1 ?? '',
                  city: data.organization.city ?? '',
                  postalCode: data.organization.postalCode ?? '',
                })
              }
            >
              Discard
            </Button>
          </div>
        </div>
      </Card>

      <Card title="Workspace facts">
        <dl className="space-y-2 text-[13px]">
          <Row label="Timezone" value={data.organization.timezone} />
          <Row label="Your role" value={data.role} />
          <Row label="Organization id" value={data.organization.id} />
        </dl>
      </Card>
    </div>
  );
}

function InvoiceSettingsTab({ data }: { data: OrganizationSettings }) {
  const { organizationId } = useParams();
  const queryClient = useQueryClient();
  const toast = useToast();
  const canManage = data.permissions.includes('settings.manage');
  const settings = data.settings;

  const [form, setForm] = useState({
    invoicePrefix: settings?.invoicePrefix ?? 'INV-',
    nextNumber: settings?.nextNumber ?? 1,
    defaultDueDays: settings?.defaultDueDays ?? 14,
    taxLabel: settings?.taxLabel ?? 'Tax',
    taxRateBasisPoints: (settings?.taxRateBasisPoints ?? 0) / 100,
    defaultTerms: settings?.defaultTerms ?? '',
    defaultNotes: settings?.defaultNotes ?? '',
    defaultPaymentInstructions: settings?.defaultPaymentInstructions ?? '',
    allowManualPayments: settings?.allowManualPayments ?? true,
  });

  const save = useMutation({
    mutationFn: () =>
      api.patch(`/${organizationId}/settings/invoices`, {
        invoicePrefix: form.invoicePrefix,
        nextNumber: Number(form.nextNumber),
        defaultDueDays: Number(form.defaultDueDays),
        taxLabel: form.taxLabel,
        taxRateBasisPoints: Math.round(Number(form.taxRateBasisPoints) * 100),
        defaultTerms: form.defaultTerms.trim() || null,
        defaultNotes: form.defaultNotes.trim() || null,
        defaultPaymentInstructions: form.defaultPaymentInstructions.trim() || null,
        allowManualPayments: form.allowManualPayments,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries();
      toast.success('Invoice settings saved.');
    },
    onError: (error: unknown) =>
      toast.error(error instanceof ApiError ? error.message : 'Could not save invoice settings.'),
  });

  return (
    <Card
      title="Invoice defaults"
      description="Applied to new invoices. Changing these never rewrites invoices that already exist."
    >
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Invoice number prefix" hint="Letters, numbers and dashes.">
            {({ id, describedBy }) => (
              <Input id={id} aria-describedby={describedBy} value={form.invoicePrefix} disabled={!canManage} onChange={(event) => setForm({ ...form, invoicePrefix: event.target.value })} />
            )}
          </Field>
          <Field label="Next number" hint="Only ever moves forward, so a used number is never reused.">
            {({ id, describedBy }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                type="number"
                min={1}
                value={form.nextNumber}
                disabled={!canManage}
                onChange={(event) => setForm({ ...form, nextNumber: Number(event.target.value) })}
              />
            )}
          </Field>
          <Field label="Default terms in days">
            {({ id, describedBy }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                type="number"
                min={0}
                max={365}
                value={form.defaultDueDays}
                disabled={!canManage}
                onChange={(event) => setForm({ ...form, defaultDueDays: Number(event.target.value) })}
              />
            )}
          </Field>
          <Field label="Tax label">
            {({ id, describedBy }) => (
              <Input id={id} aria-describedby={describedBy} value={form.taxLabel} disabled={!canManage} onChange={(event) => setForm({ ...form, taxLabel: event.target.value })} />
            )}
          </Field>
          <Field label="Default tax rate (%)" hint="Prefills new line items. CollectFlow does not guarantee tax compliance.">
            {({ id, describedBy }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                inputMode="decimal"
                value={form.taxRateBasisPoints}
                disabled={!canManage}
                onChange={(event) => setForm({ ...form, taxRateBasisPoints: Number(event.target.value) })}
              />
            )}
          </Field>
        </div>

        <Field label="Default terms text">
          {({ id, describedBy }) => (
            <Textarea id={id} aria-describedby={describedBy} value={form.defaultTerms} disabled={!canManage} onChange={(event) => setForm({ ...form, defaultTerms: event.target.value })} />
          )}
        </Field>
        <Field label="Default notes">
          {({ id, describedBy }) => (
            <Textarea id={id} aria-describedby={describedBy} value={form.defaultNotes} disabled={!canManage} onChange={(event) => setForm({ ...form, defaultNotes: event.target.value })} />
          )}
        </Field>
        <Field label="Default payment instructions" hint="Shown to the customer on the invoice.">
          {({ id, describedBy }) => (
            <Textarea
              id={id}
              aria-describedby={describedBy}
              value={form.defaultPaymentInstructions}
              disabled={!canManage}
              onChange={(event) => setForm({ ...form, defaultPaymentInstructions: event.target.value })}
            />
          )}
        </Field>

        <Checkbox
          label="Allow manual payment recording"
          hint="When off, members cannot record bank, cash or cheque payments."
          checked={form.allowManualPayments}
          disabled={!canManage}
          onChange={(event) => setForm({ ...form, allowManualPayments: event.target.checked })}
        />

        <Button variant="primary" loading={save.isPending} disabled={!canManage} onClick={() => save.mutate()}>
          Save invoice settings
        </Button>
      </div>
    </Card>
  );
}

function MembersTab() {
  const { organizationId } = useParams();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { role: myRole, user } = useSession();
  const [email, setEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('member');
  const [inviteResult, setInviteResult] = useState<{ acceptUrl: string; emailed: boolean; emailConfigured: boolean } | null>(null);

  const members = useQuery({
    queryKey: ['members', organizationId],
    queryFn: () => api.get<{ members: MemberRow[] }>(`/${organizationId}/members`),
    enabled: Boolean(organizationId),
  });

  const invite = useMutation({
    mutationFn: () => api.post<{ invitation: { acceptUrl: string; emailed: boolean; emailConfigured: boolean } }>(`/${organizationId}/members/invitations`, { email, role: inviteRole }),
    onSuccess: (result) => {
      setInviteResult(result.invitation);
      setEmail('');
      void queryClient.invalidateQueries();
    },
    onError: (error: unknown) =>
      toast.error(error instanceof ApiError ? error.message : 'The invitation could not be created.'),
  });

  const changeRole = useMutation({
    mutationFn: (input: { memberId: string; role: string }) =>
      api.patch(`/${organizationId}/members/${input.memberId}`, { role: input.role }),
    onSuccess: async () => {
      await queryClient.invalidateQueries();
      toast.success('Role updated.');
    },
    onError: (error: unknown) =>
      toast.error(error instanceof ApiError ? error.message : 'The role could not be changed.'),
  });

  const canManage = myRole === 'owner' || myRole === 'admin';

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card title="Members" className="lg:col-span-2">
        <DataTable
          caption="Organization members"
          rows={members.data?.members ?? []}
          getRowKey={(row) => row.id}
          loading={members.isLoading}
          columns={[
            {
              key: 'name',
              header: 'Member',
              render: (row) => (
                <span>
                  <span className="font-medium">{row.displayName}</span>
                  <span className="ml-2 text-xs text-ink-subtle">{row.email}</span>
                  {row.userId === user?.id ? <span className="ml-2 text-xs text-ink-subtle">(you)</span> : null}
                </span>
              ),
            },
            {
              key: 'role',
              header: 'Role',
              render: (row) =>
                row.role === 'owner' ? (
                  <Badge tone="brand">Owner</Badge>
                ) : canManage && row.role !== 'owner' ? (
                  <Select value={row.role} onChange={(event) => changeRole.mutate({ memberId: row.id, role: event.target.value })} className="h-8 w-28 py-1 text-xs">
                    <option value="admin">Admin</option>
                    <option value="member">Member</option>
                    <option value="viewer">Viewer</option>
                  </Select>
                ) : (
                  <Badge>{row.role}</Badge>
                ),
            },
          ]}
          empty={<EmptyState title="No members" description="Invite a teammate to collaborate." />}
        />
      </Card>

      <Card title="Invite a member">
        <div className="space-y-4">
          <p className="text-[13px] text-ink-muted">
            Invitations are single-use, expire after 7 days and are stored only as a hash.
          </p>
          <Field label="Email" required>
            {({ id, describedBy }) => (
              <Input id={id} aria-describedby={describedBy} type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
            )}
          </Field>
          <Field label="Role" required>
            {({ id, describedBy }) => (
              <Select id={id} aria-describedby={describedBy} value={inviteRole} onChange={(event) => setInviteRole(event.target.value)}>
                <option value="member">Member - create and edit invoices</option>
                <option value="admin">Admin - manage everything except ownership</option>
                <option value="viewer">Viewer - read only</option>
              </Select>
            )}
          </Field>
          <Button variant="primary" disabled={!canManage || !email || invite.isPending} loading={invite.isPending} onClick={() => invite.mutate()}>
            Create invitation
          </Button>

          {inviteResult ? (
            <div className="rounded-lg border border-line bg-surface-sunken p-3 text-[13px]">
              <p className="font-medium text-ink">Invitation link</p>
              <code className="mt-1 block break-all text-xs">{inviteResult.acceptUrl}</code>
              <p className="mt-2 text-ink-muted">
                {inviteResult.emailed
                  ? 'The invitation email was accepted by the provider.'
                  : inviteResult.emailConfigured
                    ? 'The email provider was unavailable, so share the link manually.'
                    : 'No email provider is configured. Share this link manually; it can be used once.'}
              </p>
              <Button className="mt-2" size="sm" onClick={() => setInviteResult(null)}>
                Done
              </Button>
            </div>
          ) : null}
        </div>
      </Card>
    </div>
  );
}

function AuditTab() {
  const { organizationId } = useParams();
  const { permissions } = useSession();
  const [page, setPage] = useState(1);

  const query = useQuery({
    queryKey: ['audit', organizationId, page],
    queryFn: () => api.get<Paginated<{ id: string; action: string; entityType: string; createdAt: string }>>(
      `/${organizationId}/audit?page=${page}&pageSize=25`,
    ),
    enabled: Boolean(organizationId) && permissions.includes('audit.view'),
  });

  if (!permissions.includes('audit.view')) {
    return (
      <Card>
        <EmptyState
          title="You do not have permission to view the audit log"
          description="Owners and admins can review role changes, integration changes and data exports."
        />
      </Card>
    );
  }

  return (
    <Card title="Audit log" description="Role changes, integration changes, destructive actions and exports.">
      <DataTable
        caption="Audit log"
        rows={query.data?.items ?? []}
        getRowKey={(row) => row.id}
        loading={query.isLoading}
        columns={[
          { key: 'action', header: 'Action', render: (row) => <span className="capitalize">{row.action.replace(/[._]/g, ' ')}</span> },
          { key: 'entity', header: 'Entity', render: (row) => row.entityType },
          { key: 'at', header: 'When', render: (row) => formatDateTime(row.createdAt) },
        ]}
        empty={<EmptyState title="No audit events yet" description="Significant changes are recorded here." />}
      />
      {query.data ? (
        <Pagination page={query.data.page} pageSize={query.data.pageSize} total={query.data.total} onPageChange={setPage} />
      ) : null}
    </Card>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-ink-subtle">{label}</dt>
      <dd className="text-ink">{value}</dd>
    </div>
  );
}