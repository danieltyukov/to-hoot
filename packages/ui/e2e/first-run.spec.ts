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

test('a master repository round-trips without ever creating a main ref', async ({ page }) => {
  /*
   * The failure this guards, driven through the real UI rather than a unit.
   *
   * The step used to seed a literal `main`. On a repository whose default is
   * `master` the ref read 404s, the client reads that as "no commits yet", and
   * the commit goes in parentless and creates an orphan refs/heads/main beside
   * the user's data. The wizard then reports success.
   */
  const seen: string[] = [];
  await page.route('**/api.github.com/**', async route => {
    const req = route.request();
    const url = req.url();
    seen.push(`${req.method()} ${url.replace('https://api.github.com', '')}`);
    const body = (value: unknown, status = 200): Parameters<typeof route.fulfill>[0] => ({
      status,
      contentType: 'application/json',
      body: JSON.stringify(value),
    });

    if (url.endsWith('/user')) return route.fulfill(body({ login: 'someone' }));
    if (/\/repos\/someone\/to-hoot-data$/.test(url)) {
      return route.fulfill(body({ default_branch: 'master', private: true }));
    }
    if (url.includes('/git/ref/heads/main')) return route.fulfill(body({ message: 'Not Found' }, 404));
    if (url.includes('/git/ref/heads/master')) {
      return route.fulfill(body({ object: { sha: 'headsha' } }));
    }
    if (url.endsWith('/git/trees')) return route.fulfill(body({ sha: 'treesha' }, 201));
    if (url.endsWith('/git/commits')) return route.fulfill(body({ sha: 'commitsha' }, 201));
    if (url.endsWith('/git/refs')) return route.fulfill(body({}, 201));
    if (req.method() === 'PATCH') return route.fulfill(body({}));
    if (url.includes('/commits?')) return route.fulfill(body([{ sha: 'commitsha' }]));
    if (url.includes('/git/trees/commitsha')) {
      return route.fulfill(
        body({ truncated: false, tree: [{ path: 'README.md', sha: 'blobsha', type: 'blob' }] }),
      );
    }
    if (url.includes('/git/blobs/blobsha')) {
      // Whatever was written. The wizard compares what comes back with what it
      // sent, so echoing the request body is what makes the round trip real.
      const written = seen.find(s => s.includes('/git/trees')) ?? '';
      return route.fulfill(body({ content: '', encoding: 'utf-8', written }));
    }
    return route.fulfill(body({}, 404));
  });

  await page.locator('[data-step="sync"]').click();
  await page.getByLabel('GitHub token', { exact: true }).fill('github_pat_x');
  await page.getByRole('button', { name: 'Verify token' }).click();
  await expect(page.locator('[data-status="ok"]')).toContainText('Signed in as someone.');

  await page.getByRole('button', { name: 'Use an existing one' }).click();
  await expect(page.locator('[data-status="ok"]').last()).toContainText('default branch master');

  await page.getByLabel('Device name').fill('laptop');
  await page.getByRole('button', { name: 'Test sync' }).click();
  await expect(page.locator('[data-status]').last()).not.toBeEmpty();

  // The point of the whole exercise: nothing was aimed at main, and no ref was
  // created. The commit went onto the branch that was already there.
  expect(seen.filter(s => s.includes('heads/main'))).toEqual([]);
  expect(seen.filter(s => s.endsWith('/git/refs'))).toEqual([]);
  expect(seen.some(s => s === 'GET /repos/someone/to-hoot-data')).toBe(true);
  expect(seen.some(s => s.includes('heads/master'))).toBe(true);

  // And the branch it found is what the Claude step then hands to wrangler.
  await page.locator('[data-step="claude"]').click();
  await expect(page.locator('.copyable-text').last()).toContainText('GITHUB_BRANCH      # master');
});
