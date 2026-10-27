import { Navigate, Route, Routes, useNavigate, useParams } from 'react-router-dom';

import { AppShell } from './components/AppShell';
import { SessionProvider, useSession } from './lib/session';
import { Button, Card, EmptyState } from './components/ui';
import { AcceptInvitationPage } from './pages/AcceptInvitation';
import { CreateOrganizationPage } from './pages/CreateOrganization';
import { CustomerDetailPage } from './pages/CustomerDetail';
import { CustomersPage } from './pages/Customers';
import { DashboardPage } from './pages/Dashboard';
import { IntegrationsPage } from './pages/Integrations';
import { InvoiceDetailPage } from './pages/InvoiceDetail';
import { InvoiceEditorPage } from './pages/InvoiceEditor';
import { InvoicesPage } from './pages/Invoices';
import { LoginPage } from './pages/Login';
import { NotFoundPage } from './pages/NotFound';
import { PaymentsPage } from './pages/Payments';
import { PublicInvoicePage } from './pages/PublicInvoice';
import { RemindersPage } from './pages/Reminders';
import { ReportsPage } from './pages/Reports';
import { SettingsPage } from './pages/Settings';

function FullPageLoading() {
  return (
    <div className="flex min-h-screen items-center justify-center" role="status" aria-live="polite">
      <span className="text-sm text-ink-muted">Loading CollectFlow…</span>
    </div>
  );
}

function RequireSession({ children }: { children: React.ReactNode }) {
  const { user, loading, memberships } = useSession();

  if (loading) return <FullPageLoading />;
  if (!user) return <Navigate to="/login" replace />;
  if (memberships.length === 0) return <Navigate to="/welcome" replace />;
  return <>{children}</>;
}

function RequireOrganization({ children }: { children: React.ReactNode }) {
  const params = useParams();
  const navigate = useNavigate();
  const { memberships, activeOrganizationId, loading } = useSession();
  const organizationId = params.organizationId;

  if (loading) return <FullPageLoading />;
  if (!organizationId) return <Navigate to="/dashboard" replace />;
  if (!memberships.some((membership) => membership.organizationId === organizationId)) {
    return (
      <FullPageMessage
        title="Organization not available"
        description="You are not a member of this organization, or it no longer exists."
        action={
          <Button variant="primary" onClick={() => navigate(`/${activeOrganizationId}/dashboard`)}>
            Go to my dashboard
          </Button>
        }
      />
    );
  }
  return <>{children}</>;
}

function FullPageMessage({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <EmptyState title={title} description={description} {...(action ? { action } : {})} />
      </Card>
    </div>
  );
}

function RedirectToFirstOrganization() {
  const { memberships, loading } = useSession();
  if (loading) return <FullPageLoading />;
  const first = memberships[0];
  if (!first) return <Navigate to="/welcome" replace />;
  return <Navigate to={`/${first.organizationId}/dashboard`} replace />;
}

function OrganizationLayout() {
  return (
    <AppShell>
      <Routes>
        <Route index element={<Navigate to="dashboard" replace />} />
        <Route path="dashboard" element={<DashboardPage />} />
        <Route path="invoices" element={<InvoicesPage />} />
        <Route path="invoices/new" element={<InvoiceEditorPage />} />
        <Route path="invoices/:invoiceId" element={<InvoiceDetailPage />} />
        <Route path="invoices/:invoiceId/edit" element={<InvoiceEditorPage />} />
        <Route path="customers" element={<CustomersPage />} />
        <Route path="customers/:customerId" element={<CustomerDetailPage />} />
        <Route path="payments" element={<PaymentsPage />} />
        <Route path="reports" element={<ReportsPage />} />
        <Route path="reminders" element={<RemindersPage />} />
        <Route path="integrations" element={<IntegrationsPage />} />
        <Route path="settings/*" element={<SettingsPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </AppShell>
  );
}

export function AppRouter() {
  return (
    <SessionProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<Navigate to="/login" replace />} />
        <Route path="/forgot-password" element={<Navigate to="/login" replace />} />
        <Route path="/reset-password" element={<Navigate to="/login" replace />} />
        <Route path="/accept-invitation" element={<AcceptInvitationPage />} />
        <Route path="/welcome" element={<RequireSession><CreateOrganizationPage /></RequireSession>} />
        <Route
          path="/i/:token"
          element={
            <FullPageMessage
              title="Invoice link"
              description="Open this link in the CollectFlow web app to view the invoice."
              action={<a href="/login">Go to CollectFlow</a>}
            />
          }
        />
        <Route path="/public/invoices/:token" element={<PublicInvoicePage />} />
        <Route path="/dashboard" element={<RequireSession><RedirectToFirstOrganization /></RequireSession>} />
        <Route
          path="/:organizationId/*"
          element={
            <RequireSession>
              <RequireOrganization>
                <OrganizationLayout />
              </RequireOrganization>
            </RequireSession>
          }
        />
        <Route path="/" element={<RequireSession><RedirectToFirstOrganization /></RequireSession>} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </SessionProvider>
  );
}