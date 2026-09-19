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

test('leads the calendar step with one sign-in button and folds the script away', async ({ page }) => {
  await page.locator('[data-step="calendar"]').click();
  // The button is there in every shell. In a browser tab it is disabled and
  // says why, since a tab has nowhere to receive Google's redirect.
  await expect(page.getByRole('button', { name: 'Sign in with Google' })).toBeVisible();
  await expect(page.getByLabel('Shared secret', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Use an Apps Script bridge instead' })).toBeVisible();
});

test('generates a calendar secret nobody is asked to choose', async ({ page }) => {
  await page.locator('[data-step="calendar"]').click();
  await page.getByRole('button', { name: 'Use an Apps Script bridge instead' }).click();
  await page.getByRole('button', { name: 'Show the script' }).click();

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
  await page.getByRole('button', { name: 'Use an Apps Script bridge instead' }).click();
  await page.getByRole('button', { name: 'Show the script' }).click();
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
  // Sign in with GitHub is the button; the token is the path folded under it.
  await expect(page.getByRole('button', { name: 'Sign in with GitHub' })).toBeVisible();
  await page.getByRole('button', { name: 'Use a token instead' }).click();
  await page.getByLabel('GitHub token', { exact: true }).fill('github_pat_wrong');
  await page.getByRole('button', { name: 'Verify token' }).click();

  await expect(page.locator('[role="status"][data-status="error"]')).toContainText(
    'GitHub rejected the token.',
  );
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
  // What the app asked to be written, so the blob read-back can echo it. A fake
  // that returns something else makes the round-trip check fail for a reason
  // that has nothing to do with the app.
  let writtenReadme = '';
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
    // The flow finds the repository in the account's own listing rather than
    // asking anyone to type its name.
    if (url.includes('/user/repos?')) {
      return route.fulfill(body([{ full_name: 'someone/to-hoot-data', default_branch: 'master' }]));
    }
    if (/\/repos\/someone\/to-hoot-data$/.test(url)) {
      return route.fulfill(body({ default_branch: 'master', private: true }));
    }
    if (url.includes('/git/ref/heads/main')) return route.fulfill(body({ message: 'Not Found' }, 404));
    if (url.includes('/git/ref/heads/master')) {
      return route.fulfill(body({ object: { sha: 'headsha' } }));
    }
    if (url.endsWith('/git/trees')) {
      const sent = JSON.parse(req.postData() ?? '{}') as {
        tree?: Array<{ path: string; content?: string }>;
      };
      const readme = (sent.tree ?? []).find(e => e.path === 'README.md');
      if (readme?.content !== undefined) writtenReadme = readme.content;
      return route.fulfill(body({ sha: 'treesha' }, 201));
    }
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
      // Echo what was written. The wizard compares the two, which is the point
      // of the check, so a fake that returns anything else tests nothing.
      return route.fulfill(
        body({ content: Buffer.from(writtenReadme, 'utf8').toString('base64'), encoding: 'base64' }),
      );
    }
    return route.fulfill(body({}, 404));
  });

  await page.locator('[data-step="sync"]').click();
  await page.getByRole('button', { name: 'Use a token instead' }).click();
  await page.getByLabel('GitHub token', { exact: true }).fill('github_pat_x');
  await page.getByRole('button', { name: 'Verify token' }).click();
  await expect(page.getByText(/Signed in as someone/)).toBeVisible();

  // The repository was found in the listing, its branch read from the API,
  // this device named after what it is, and the round trip run, with nobody
  // pressing anything else.
  await expect(page.getByText(/default branch master/)).toBeVisible();
  await expect(page.getByLabel('Device name')).toHaveValue('browser');
  await expect(page.getByText('Connected. Tasks from every device appear here.')).toBeVisible();

  // The point of the whole exercise: nothing was aimed at main, and no ref was
  // created. The commit went onto the branch that was already there.
  expect(seen.filter(s => s.includes('heads/main'))).toEqual([]);
  expect(seen.filter(s => s.endsWith('/git/refs'))).toEqual([]);
  expect(seen.some(s => s === 'GET /repos/someone/to-hoot-data')).toBe(true);
  expect(seen.some(s => s.includes('heads/master'))).toBe(true);

  // And the branch it found is what the Claude step then hands to wrangler,
  // under the folded-away wrangler path.
  await page.locator('[data-step="claude"]').click();
  await page.getByRole('button', { name: 'Deploy with wrangler instead' }).click();
  await expect(page.locator('.copyable-text').last()).toContainText('GITHUB_BRANCH      # master');
});

test('holds the wizard chrome clear of the phone system bars', async ({ page }) => {
  /*
   * Chromium cannot be told to report real safe-area insets, so this forces a
   * phone's worth of them onto the shell and checks what the layout then does.
   *
   * Which is to say it proves the arithmetic, not the rule: it would still pass
   * with the `env()` padding deleted from App.css, because it supplies its own.
   * styles.test.ts is what fails if the rule goes. What is worth a viewport is
   * the part that cannot be read off a stylesheet, and the part that made the
   * fix worth checking rather than assuming: a shell that is `height: 100%`
   * grows past the screen once it takes padding unless `box-sizing` is
   * border-box, and a wizard footer that is lifted by a navigation bar's height
   * is one edit away from being pushed off the bottom of the screen instead.
   */
  const top = 40;
  const bottom = 48;
  await page.setViewportSize({ width: 412, height: 915 });
  await page.addStyleTag({
    content: `.shell { padding-top: ${top}px; padding-bottom: ${bottom}px; }`,
  });

  const head = (await page.locator('.wizard-head').boundingBox())!;
  const foot = (await page.locator('.wizard-foot').boundingBox())!;
  const viewport = page.viewportSize()!.height;

  expect(head.y).toBeGreaterThanOrEqual(top);
  expect(foot.y + foot.height).toBeLessThanOrEqual(viewport - bottom);

  // Lifted clear, not pushed off: a shell that outgrew the viewport would put
  // the footer past the bottom of the screen and scroll the page to reach it.
  await expect(page.getByRole('button', { name: 'Next' })).toBeInViewport();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollHeight - window.innerHeight,
  );
  expect(overflow).toBe(0);
});
