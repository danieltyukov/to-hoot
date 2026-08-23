import { expect, test, type Page } from '@playwright/test';

const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };
const NARROW = { width: 360, height: 780 };

const pane = (page: Page, name: 'lists' | 'tasks' | 'day') => page.locator(`.pane-${name}`);

async function addTask(page: Page, title: string): Promise<void> {
  await page.getByLabel('New task').fill(title);
  await page.getByLabel('New task').press('Enter');
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByLabel('New task')).toBeVisible();
});

test('three panes on desktop, tabs on mobile', async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  for (const name of ['lists', 'tasks', 'day'] as const) {
    await expect(pane(page, name)).toBeVisible();
  }
  await expect(page.getByRole('navigation', { name: 'Panes' })).toBeHidden();

  await page.setViewportSize(PHONE);
  // The same three panes, one at a time. Nothing is unmounted and rebuilt.
  await expect(pane(page, 'tasks')).toBeVisible();
  await expect(pane(page, 'lists')).toBeHidden();
  await expect(pane(page, 'day')).toBeHidden();

  const tabs = page.getByRole('navigation', { name: 'Panes' });
  await expect(tabs).toBeVisible();
  await tabs.getByRole('button', { name: 'Day' }).click();
  await expect(pane(page, 'day')).toBeVisible();
  await expect(pane(page, 'tasks')).toBeHidden();
});

test('adding a task shows it in Today', async ({ page }) => {
  await addTask(page, 'Rewire the bench');

  const today = page.getByRole('region', { name: 'Today' });
  await expect(today.getByText('Rewire the bench')).toBeVisible();
  await expect(today.getByText('1 left')).toBeVisible();
  // The field clears, so the next one can be typed straight in.
  await expect(page.getByLabel('New task')).toHaveValue('');
});

test('starting a timer ticks the visible duration', async ({ page }) => {
  await addTask(page, 'Rewire the bench');
  await page.getByRole('button', { name: 'Start timer for Rewire the bench' }).click();

  const row = page.locator('.row', { hasText: 'Rewire the bench' });
  await expect(row.locator('.row-time')).toHaveText(/0:0[1-9]/, { timeout: 5_000 });
  const first = await row.locator('.row-time').textContent();

  await expect(row.locator('.row-time')).not.toHaveText(first!, { timeout: 5_000 });
  await expect(page.getByRole('button', { name: /^Stop timer/ })).toBeVisible();
});

test('completing a task moves it to done and banks its time', async ({ page }) => {
  await addTask(page, 'Rewire the bench');
  await page.getByRole('button', { name: 'Start timer for Rewire the bench' }).click();
  await page.getByRole('checkbox', { name: 'Complete Rewire the bench' }).click();

  const done = page.locator('[data-group="done"]');
  await expect(done.getByText('Rewire the bench')).toBeVisible();
  await expect(done.locator('.row-title')).toHaveCSS('text-decoration-line', 'line-through');
  await expect(page.locator('[data-empty]')).toHaveText('Today is done.');
  // The terminal state asks for nothing.
  await expect(page.locator('[data-empty] button')).toHaveCount(0);
});

test('theme toggle persists across reload', async ({ page }) => {
  await page.getByRole('button', { name: 'Dark mode' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByRole('button', { name: 'Dark mode' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});

test('the page never scrolls horizontally at 360px', async ({ page }) => {
  await page.setViewportSize(NARROW);
  await addTask(page, 'A task with a title long enough to want more room than it has');

  for (const tab of ['lists', 'tasks', 'day'] as const) {
    await page.locator(`[data-tab="${tab}"]`).click();
    await expect(pane(page, tab)).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      `${tab} pane overflows at 360px`,
    ).toBe(true);
  }
});

test('every control the mobile suite has to address carries a name', async ({ page }) => {
  // Maestro drives the Android build through the accessibility tree and matches
  // on nothing else. An unnamed control is not awkward there, it is unreachable.
  await addTask(page, 'Rewire the bench');

  const unnamed = await page.evaluate(() => {
    const controls = [...document.querySelectorAll('button, input, [role="checkbox"]')];
    return controls
      .filter(el => {
        const text = el.textContent?.trim() ?? '';
        const label = el.getAttribute('aria-label') ?? el.getAttribute('aria-labelledby') ?? '';
        return text === '' && label === '';
      })
      .map(el => el.outerHTML);
  });
  expect(unnamed).toEqual([]);
});
