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

test('the day opens on now, not on the small hours', async ({ page }) => {
  await page.setViewportSize(NARROW);
  await page.locator('[data-tab="day"]').click();

  // The chip rather than the .now wrapper: the wrapper is a zero-height anchor
  // for three absolutely positioned children, so it has no box to be visible.
  const marker = page.locator('.now-chip');
  await expect(marker).toBeVisible();

  // Visible is not enough: the grid is up to 24 hours tall, and the complaint
  // was that the line sits behind the footer with only the small hours on
  // screen. Assert the marker is inside the grid's own viewport.
  const [line, grid] = await Promise.all([
    marker.boundingBox(),
    page.locator('.timeline-grid').boundingBox(),
  ]);
  expect(line!.y).toBeGreaterThanOrEqual(grid!.y);
  expect(line!.y + line!.height).toBeLessThanOrEqual(grid!.y + grid!.height);
});

test('the wordmark is still one word to anything that reads it', async ({ page }) => {
  // It is assembled from spans so the two `o`s can hold a pupil. Selection,
  // search and the accessible name all come from textContent, so the word has
  // to survive being cut up.
  await page.setViewportSize(DESKTOP);
  await expect(page.getByText('to-hoot', { exact: true })).toBeVisible();
});

test('the accent is never used as a text colour', async ({ page }) => {
  // The token sheet holds --accent to 3:1, which is the non-text threshold and
  // is only honest while nothing sets words in it. Words take --accent-hover,
  // which clears 4.5:1 in both themes.
  await addTask(page, 'Rewire the bench');
  await page.getByRole('button', { name: 'Start timer for Rewire the bench' }).click();

  const offenders = await page.evaluate(() => {
    const probe = document.createElement('span');
    probe.style.color = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
    document.body.append(probe);
    const accent = getComputedStyle(probe).color;
    probe.remove();

    return [...document.querySelectorAll<HTMLElement>('body *')]
      .filter(el => {
        const ownText = [...el.childNodes].some(
          n => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim() !== '',
        );
        return ownText && getComputedStyle(el).color === accent;
      })
      .map(el => el.outerHTML.slice(0, 120));
  });
  expect(offenders).toEqual([]);
});

test('a whole day can be planned and tracked without leaving the app', async ({ page }) => {
  await page.setViewportSize(DESKTOP);

  // A project, which nothing in the product could make before.
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByLabel('New project name').fill('Radio');
  await page.getByLabel('New project name').press('Enter');
  await expect(page.getByRole('heading', { name: 'Radio' })).toBeVisible();

  await addTask(page, 'Solder the preamp');
  await page.getByRole('button', { name: 'Solder the preamp', exact: true }).click();

  // An estimate, which is what gives the ring and the day header a scale.
  await page.getByLabel('Estimate').fill('1h 30m');
  await page.getByLabel('Estimate').blur();
  // A time, which is what puts it on the timeline.
  await page.getByLabel('Due time').fill('11:00');
  await page.getByRole('button', { name: 'Back to the list' }).click();

  const block = page.locator('[data-event]');
  await expect(block).toHaveText(/Solder the preamp/);
  await expect(block).toHaveText(/11:00/);

  const ring = page.getByRole('progressbar');
  await expect(ring).toHaveAttribute('aria-valuemax', String(90 * 60_000));
  await expect(page.locator('.timeline-totals')).toContainText('1h 30m');

  // And a tracked session against it.
  await page.getByRole('button', { name: 'Start timer for Solder the preamp' }).click();
  await expect(page.locator('.lane-tracked [data-tracked]')).toBeVisible();
  await expect(page.locator('.row-time')).toHaveText(/0:0[1-9]/, { timeout: 5_000 });
  await page.getByRole('button', { name: 'Stop timer for Solder the preamp' }).click();

  // The time is in the log, on the day, and the detail says so.
  await page.getByRole('button', { name: 'Solder the preamp', exact: true }).click();
  await expect(page.locator('[data-tracked-day]')).toHaveCount(1);
  await expect(page.locator('.foot-value')).toContainText('of 1h 30m');
});

test('the UI never offers to nest a third level of subtask', async ({ page }) => {
  // Core rejects it, so an offer here would be an action that looks like it
  // worked and silently did nothing.
  await addTask(page, 'Rewire the bench');
  await page.getByRole('button', { name: 'Rewire the bench', exact: true }).click();
  await page.getByLabel('New subtask').fill('Order the wire');
  await page.getByLabel('New subtask').press('Enter');

  await page.getByRole('button', { name: 'Order the wire', exact: true }).click();
  await expect(page.getByLabel('New subtask')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Rewire the bench', exact: true })).toBeVisible();
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
