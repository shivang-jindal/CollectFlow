#!/usr/bin/env node
/**
 * Post-migration smoke test (Part A / A8 "Include a smoke test after deployment").
 *
 * Signs in with the seeded demo account and walks the primary journey:
 * login -> dashboard -> invoices -> receivables -> integrations.
 * Exits non-zero on the first failure.
 *
 * Usage: node scripts/smoke.mjs [baseUrl]
 */

const baseUrl = process.argv[2] ?? process.env.SMOKE_API_URL ?? 'http://localhost:4000';
const email = process.env.SEED_EMAIL ?? 'demo@collectflow.test';
const password = process.env.SEED_PASSWORD ?? 'collectflow-demo-1234';

let cookie = '';

function recordCookie(response) {
  const setCookie = response.headers.getSetCookie?.() ?? [];
  for (const entry of setCookie) {
    const [pair] = entry.split(';');
    if (pair?.startsWith('collectflow_session=')) cookie = pair;
  }
}

async function call(method, path, body) {
  const response = await fetch(`${baseUrl}/api/v1${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  recordCookie(response);
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  return { status: response.status, json, text };
}

function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ok   ${label}${detail ? ` - ${detail}` : ''}`);
  } else {
    console.error(`  FAIL ${label}${detail ? ` - ${detail}` : ''}`);
    process.exitCode = 1;
  }
}

const ready = await fetch(`${baseUrl}/api/v1/health/ready`);
const readyJson = await ready.json();
check('health/ready', ready.status === 200 && readyJson.status === 'ready', JSON.stringify(readyJson.checks));

const login = await call('POST', '/auth/login', { email, password });
check('auth/login', login.status === 200 && Boolean(login.json?.user?.id), login.json?.error?.message ?? '');
if (login.status !== 200) process.exit(1);

const orgId = login.json.memberships?.[0]?.organizationId;
check('session has an organization', Boolean(orgId));

const dashboard = await call('GET', `/${orgId}/dashboard`);
check('dashboard', dashboard.status === 200, dashboard.json?.error?.message ?? '');
check(
  'dashboard reports outstanding grouped by currency',
  Array.isArray(dashboard.json?.outstanding),
  JSON.stringify(dashboard.json?.outstanding),
);

const invoices = await call('GET', `/${orgId}/invoices?pageSize=5`);
check('invoice list', invoices.status === 200 && Array.isArray(invoices.json?.items));
const first = invoices.json?.items?.[0];
check('invoice row has a derived status', Boolean(first?.displayStatus), first?.displayStatus);

const receivables = await call('GET', `/${orgId}/reports/receivables`);
check('receivables report', receivables.status === 200 && Array.isArray(receivables.json?.buckets));

// A bucket carries exactly one currency, so amounts from different currencies
// are never added together.
const buckets = receivables.json?.buckets ?? [];
check(
  'every aging bucket is denominated in a single currency',
  buckets.length > 0 &&
    buckets.every(
      (bucket) =>
        (bucket.currency === null || typeof bucket.currency === 'string') &&
        Number.isInteger(bucket.amountMinor) &&
        typeof bucket.bucket === 'string',
    ),
  JSON.stringify(buckets),
);

// Follow-ups must carry the invoice identity the dashboard links to.
const followUps = dashboard.json?.followUps ?? [];
check(
  'dashboard follow-ups identify their invoice',
  followUps.every((row) => row.invoiceId && row.invoiceNumber && row.customerName),
  JSON.stringify(followUps),
);

// The single outstanding column is denominated in the workspace base currency.
const customers = await call('GET', `/${orgId}/customers?page=1&pageSize=50`);
check(
  'customer outstanding is a single-currency amount',
  customers.status === 200 &&
    (customers.json?.items ?? []).every((row) => Number.isInteger(row.outstandingMinor)),
  JSON.stringify(customers.json?.items?.slice(0, 2)),
);

const integrations = await call('GET', `/${orgId}/integrations`);
const statuses = Object.fromEntries(
  (integrations.json?.integrations ?? []).map((item) => [item.provider, item.status]),
);
check(
  'integrations report a truthful status',
  integrations.status === 200 && statuses.email_smtp === 'not_configured',
  JSON.stringify(statuses),
);

const tenantProbe = await call('GET', `/${orgId}/invoices/not-a-uuid`);
check('invalid id is rejected with 400', tenantProbe.status === 400, `status=${tenantProbe.status}`);

console.log(process.exitCode ? '\nSmoke test FAILED' : '\nSmoke test passed');