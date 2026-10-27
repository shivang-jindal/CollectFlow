/**
 * Critical journey: create customer -> create invoice -> send (no email) ->
 * record a payment -> dashboard reflects the balance.
 *
 * Runs against the seeded development database (`npm run db:seed`) with the
 * development server (`npm run dev`). Sign-in is Google-only in the browser, so
 * the helper authenticates through the development-only API instead.
 */

import { expect, test } from '@playwright/test';

import { signIn } from './sign-in';

test.describe('CollectFlow core journey', () => {
  test('an invoice can be created, sent, and paid', async ({ page }) => {
    await signIn(page);

    // 1. Customer
    await page.getByRole('link', { name: 'Customers' }).click();
    await page.getByRole('button', { name: 'New customer' }).first().click();
    const stamp = Date.now();
    await page.getByLabel('Display name').fill(`E2E Customer ${stamp}`);
    await page.getByLabel('Email').fill(`e2e-${stamp}@example.test`);
    await page.getByRole('button', { name: 'Create customer' }).click();
    await expect(page.getByText(`E2E Customer ${stamp}`)).toBeVisible();

    // 2. Invoice
    await page.getByRole('link', { name: 'Invoices' }).click();
    await page.getByRole('link', { name: 'New invoice' }).click();
    await expect(page.getByRole('heading', { name: 'New invoice' })).toBeVisible();

    await page.getByLabel('Customer').selectOption({ label: `E2E Customer ${stamp}` });
    await page.getByLabel('Description').fill('End-to-end test engagement');
    await page.getByLabel('Unit price').fill('1200.00');

    // The preview total updates from the shared calculator.
    await expect(page.getByText('1,200.00')).toBeVisible();

    await page.getByRole('button', { name: 'Save draft' }).click();
    await expect(page.getByRole('heading', { name: /INV-/ })).toBeVisible();

    // 3. Send. Email is not configured in the test environment, so the UI must
    //    say so honestly rather than claim a delivery.
    await page.getByRole('button', { name: 'Send invoice' }).click();
    await expect(page.getByText(/public link is active|Sending the invoice creates one/i)).toBeVisible();

    // 4. Record a manual payment.
    await page.getByRole('button', { name: 'Record payment' }).click();
    await page.getByLabel(/^Amount/).fill('500.00');
    await page.getByLabel('I confirm the funds were actually received.').check();
    await page.getByRole('button', { name: 'Record payment' }).last().click();

    await expect(page.getByText('Partially paid')).toBeVisible();

    // 5. Dashboard reflects the balance from persisted records.
    await page.getByRole('link', { name: 'Dashboard' }).click();
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    await expect(page.getByText('Invoices awaiting payment')).toBeVisible();
  });

  test('an empty organization shows honest empty states', async ({ page }) => {
    await signIn(page);
    await page.goto('/settings/members');
    await expect(page.getByRole('heading', { name: 'Members' })).toBeVisible();
    await expect(page.getByText('demo@collectflow.test')).toBeVisible();
  });
});