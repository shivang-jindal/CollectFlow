/** The primary journey must be usable at 360 px width. */

import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 360, height: 740 } });

const EMAIL = process.env.SEED_EMAIL ?? 'demo@collectflow.test';
const PASSWORD = process.env.SEED_PASSWORD ?? 'collectflow-demo-1234';

test('navigation and the invoice list work on a small screen', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('link', { name: 'Invoices' }).click();
  await expect(page.getByRole('heading', { name: 'Invoices' })).toBeVisible();

  // No horizontal overflow of the document itself.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});