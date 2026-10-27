/** The primary journey must be usable at 360 px width. */

import { expect, test } from '@playwright/test';

import { signIn } from './sign-in';

test.use({ viewport: { width: 360, height: 740 } });

test('navigation and the invoice list work on a small screen', async ({ page }) => {
  await signIn(page);

  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('link', { name: 'Invoices' }).click();
  await expect(page.getByRole('heading', { name: 'Invoices' })).toBeVisible();

  // No horizontal overflow of the document itself.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});