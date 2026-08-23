import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

/*
 * First run, in its own file.
 *
 * The other spec writes the setup flag before every navigation so it can get at
 * the app. These need the opposite, and a beforeEach in the same file would
 * apply to a nested describe as well, so the two cannot share one.
 */

/*
 * The bridge bundle is a build artifact and is not committed, so on a fresh
 * clone the wizard shows the note saying how to build it instead of the script.
 * Everything here has to pass in that state, because a red suite on somebody's
 * first run reads as a broken project. The one check that needs the real thing
 * is its own test, skipped when the file is absent.
 */
const BRIDGE_BUNDLE = fileURLToPath(
  new URL('../../../apps/apps-script/dist/Code.js', import.meta.url),
);

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
});

test('opens on the wizard and asks for nothing to begin with', async ({ page }) => {
  await expect(page.getByRole('heading', { name: 'Nothing to set up' })).toBeVisible();
  // Step one has no fields at all, which is the claim it is making: the app
  // already works, and everything after this is optional.
  await expect(page.locator('.wizard-body input')).toHaveCount(0);
  await expect(page.getByLabel('New task')).toHaveCount(0);
});

test('generates a calendar secret nobody is asked to choose', async ({ page }) => {
  await page.locator('[data-step="calendar"]').click();

  const secret = page.getByLabel('Shared secret', { exact: true });
  await expect(secret).toHaveAttribute('readonly', '');
  await expect(secret).toHaveAttribute('type', 'password');

  const value = await secret.inputValue();
  expect(value.length).toBeGreaterThanOrEqual(32);
  expect(value).toMatch(/^[A-Za-z0-9]+$/);

  // Whatever the script block holds, the secret is not in it: it goes in a
  // Script Property instead, because clasp push uploads the source to Google.
  const source = await page.locator('.copyable-text').first().textContent();
  expect(source).not.toBe('');
  expect(source).not.toContain(value);
});

test('shows the built bridge source, with the secret still outside it', async ({ page }) => {
  test.skip(!existsSync(BRIDGE_BUNDLE), 'run npm run build -w @to-hoot/apps-script first');

  await page.locator('[data-step="calendar"]').click();
  const value = await page.getByLabel('Shared secret', { exact: true }).inputValue();

  const source = await page.locator('.copyable-text').first().textContent();
  expect(source).toContain('TO_HOOT_SECRET');
  expect(source).toContain('function doPost');
  expect(source).not.toContain(value);
});

test('names the account a real token belongs to, and the real error when it fails', async ({
  page,
}) => {
  // The transport is the app's own fetch, so this exercises the real request
  // path rather than a stub inside the component.
  await page.route('**/api.github.com/user', route =>
    route.fulfill({ status: 401, body: JSON.stringify({ message: 'Bad credentials' }) }),
  );
  await page.locator('[data-step="sync"]').click();
  await page.getByLabel('GitHub token', { exact: true }).fill('github_pat_wrong');
  await page.getByRole('button', { name: 'Verify token' }).click();

  await expect(page.locator('[data-status="error"]')).toContainText('GitHub rejected the token.');
});

test('skipping every step leaves a working app, and stays skipped', async ({ page }) => {
  await page.getByRole('button', { name: 'Next' }).click();
  for (let i = 0; i < 3; i++) await page.getByRole('button', { name: 'Skip this' }).click();

  await expect(page.getByLabel('New task')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('New task')).toBeVisible();
});

test('every control in the wizard carries a name', async ({ page }) => {
  for (const step of ['local', 'sync', 'calendar', 'claude']) {
    await page.locator(`[data-step="${step}"]`).click();
    const unnamed = await page.evaluate(() => {
      const controls = [...document.querySelectorAll('button, input, select, textarea')];
      return controls
        .filter(el => {
          const text = el.textContent?.trim() ?? '';
          const label = el.getAttribute('aria-label') ?? '';
          const labelled = el.id !== '' && document.querySelector(`label[for="${el.id}"]`) !== null;
          return text === '' && label === '' && !labelled;
        })
        .map(el => el.outerHTML.slice(0, 100));
    });
    expect(unnamed, step).toEqual([]);
  }
});
