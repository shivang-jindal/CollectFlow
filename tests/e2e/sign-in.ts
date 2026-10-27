/**
 * E2E sign-in helper.
 *
 * The web app is Google-only, so there is no password form to drive. Google's
 * popup needs a real Firebase project and a real Google account, which an
 * offline test run cannot provide. Instead the tests authenticate through the
 * same development-only API the smoke script uses and share the resulting
 * session cookie with the browser context.
 *
 * The password endpoints return 404 in production; these tests run against the
 * development server, as documented in `playwright.config.ts`.
 */

import { expect, type Page } from '@playwright/test';

const API_URL = process.env.E2E_API_URL ?? 'http://localhost:4000';
const EMAIL = process.env.SEED_EMAIL ?? 'demo@collectflow.test';
const PASSWORD = process.env.SEED_PASSWORD ?? 'collectflow-demo-1234';

export async function signIn(page: Page) {
  // `page.request` shares cookie storage with the page's browser context, so the
  // session cookie set by the API is sent with every subsequent page request.
  const response = await page.request.post(`${API_URL}/api/v1/auth/login`, {
    data: { email: EMAIL, password: PASSWORD },
  });
  expect(response.ok(), `API sign-in failed with ${response.status()}`).toBeTruthy();

  await page.goto('/dashboard');
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
}
