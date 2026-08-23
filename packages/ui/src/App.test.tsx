import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import App, { TICK_MS } from './App.js';
import { FLUSH_MS, Store } from './store.js';

const NOW = new Date(2026, 7, 23, 10, 0, 0).getTime();

/*
 * The clock is injected rather than faked.
 *
 * Vitest's fake timers and user-event deadlock in this combination, and faking
 * the clock globally would in any case be testing the interval rather than the
 * behaviour. Driving `store.tick()` in the same 1s steps the interval uses is
 * the same sequence of calls, without the deadlock. That the interval exists and
 * runs at that rate is asserted separately.
 */
function setup() {
  const storage = new Map<string, string>();
  let clock = NOW;
  const store = new Store({
    now: () => clock,
    storage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => void storage.set(key, value),
    },
  });
  const utils = render(<App store={store} />);

  const advance = (ms: number): void => {
    act(() => {
      for (let left = ms; left > 0; left -= TICK_MS) {
        clock += Math.min(TICK_MS, left);
        store.tick();
      }
    });
  };

  return { ...utils, store, storage, advance, user: userEvent.setup() };
}

const addTask = async (user: ReturnType<typeof userEvent.setup>, title: string): Promise<void> => {
  await user.type(screen.getByLabelText('New task'), `${title}{Enter}`);
};

afterEach(() => {
  delete document.documentElement.dataset['theme'];
});

describe('App', () => {
  it('renders all three panes in one tree', () => {
    // The mobile layout hides panes with CSS rather than unmounting them, which
    // is what keeps the two layouts from becoming two implementations.
    const { container } = setup();
    expect(container.querySelector('.pane-lists')).not.toBeNull();
    expect(container.querySelector('.pane-tasks')).not.toBeNull();
    expect(container.querySelector('.pane-day')).not.toBeNull();
  });

  it('keeps the tab bar out of the way at desktop width', () => {
    // jsdom renders at 1024px and does not re-evaluate media queries on resize,
    // so the mobile half of this lives in the Playwright spec.
    const { container } = setup();
    const tabs = container.querySelector('.tabs')!;
    expect(tabs.querySelectorAll('[data-tab]')).toHaveLength(3);
    expect(getComputedStyle(tabs).display).toBe('none');
  });

  it('adding a task shows it in Today', async () => {
    const { user } = setup();
    await addTask(user, 'Rewire the bench');

    const list = screen.getByRole('region', { name: 'Today' });
    expect(within(list).getByText('Rewire the bench')).toBeInTheDocument();
    expect(within(list).getByText('1 left')).toBeInTheDocument();
  });

  it('starting a timer ticks the visible duration', async () => {
    const { user, advance } = setup();
    await addTask(user, 'Rewire the bench');
    await user.click(screen.getByRole('button', { name: 'Start timer for Rewire the bench' }));

    advance(3_000);
    expect(screen.getByText('0:03')).toBeInTheDocument();

    advance(4_000);
    expect(screen.getByText('0:07')).toBeInTheDocument();
  });

  it('runs that clock on an interval rather than on a render', () => {
    const spy = vi.spyOn(globalThis, 'setInterval');
    setup();
    expect(spy).toHaveBeenCalledWith(expect.any(Function), TICK_MS);
    spy.mockRestore();
  });

  it('writes the time to the log on a flush, not once a second', async () => {
    // One event a second would be correct and unsyncable: an hour of tracking
    // would be 3600 events to merge and replay. The display does not wait for
    // the flush, which is what lets the flush be this slow.
    const { user, store, advance } = setup();
    await addTask(user, 'Rewire the bench');
    await user.click(screen.getByRole('button', { name: /^Start timer/ }));
    const before = store.getSnapshot().events.length;

    advance(FLUSH_MS - TICK_MS);
    expect(store.getSnapshot().events).toHaveLength(before);
    expect(screen.getByText('0:29')).toBeInTheDocument();

    advance(TICK_MS);
    expect(store.getSnapshot().events.length).toBeGreaterThan(before);
  });

  it('stopping banks the seconds since the last flush', async () => {
    const { user, store, advance } = setup();
    await addTask(user, 'Rewire the bench');
    const taskId = Object.keys(store.getSnapshot().state.tasks)[0]!;

    await user.click(screen.getByRole('button', { name: /^Start timer/ }));
    advance(9_000);
    await user.click(screen.getByRole('button', { name: /^Stop timer/ }));

    // Nine seconds, in the log rather than only on the screen.
    expect(store.getSnapshot().state.tasks[taskId]!.timeSpent).toBe(9_000);
    expect(store.getSnapshot().runningTaskId).toBeNull();
  });

  it('banks the running time when the running task is completed', async () => {
    // Otherwise the last stretch is thrown away by the act of finishing, which
    // is the moment someone most wants it counted.
    const { user, store, advance } = setup();
    await addTask(user, 'Rewire the bench');
    const taskId = Object.keys(store.getSnapshot().state.tasks)[0]!;

    await user.click(screen.getByRole('button', { name: /^Start timer/ }));
    advance(12_000);
    await user.click(screen.getByRole('checkbox', { name: 'Complete Rewire the bench' }));

    expect(store.getSnapshot().state.tasks[taskId]!.timeSpent).toBe(12_000);
    expect(store.getSnapshot().runningTaskId).toBeNull();
  });

  it('switches panes from the tab bar', async () => {
    const { user, container } = setup();
    expect(container.querySelector('.app')).toHaveAttribute('data-pane', 'tasks');

    const day = container.querySelector<HTMLElement>('[data-tab="day"]')!;
    await user.click(day);
    expect(container.querySelector('.app')).toHaveAttribute('data-pane', 'day');
    expect(day).toHaveAttribute('aria-current', 'page');
  });

  it('follows a sidebar choice back to the task pane', async () => {
    // On a phone the sidebar is a whole screen, so choosing a view there and
    // being left looking at the sidebar is a dead end.
    const { user, container } = setup();
    await user.click(container.querySelector<HTMLElement>('[data-tab="lists"]')!);
    await user.click(screen.getByRole('button', { name: /Today/ }));
    expect(container.querySelector('.app')).toHaveAttribute('data-pane', 'tasks');
  });

  it('puts the theme on the document and remembers the choice', async () => {
    const { user, storage } = setup();
    await user.click(screen.getByRole('button', { name: 'Dark mode' }));

    expect(document.documentElement.dataset['theme']).toBe('dark');
    expect(storage.get('to-hoot:theme')).toBe('dark');
    expect(screen.getByRole('button', { name: 'Dark mode' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('reads the remembered theme back before any log has loaded', () => {
    // The log is not persisted yet, so the local copy is the only thing that
    // survives a reload. It is written to both.
    const storage = new Map([['to-hoot:theme', 'dark']]);
    render(
      <App
        store={
          new Store({
            storage: { getItem: k => storage.get(k) ?? null, setItem: () => undefined },
          })
        }
      />,
    );
    expect(document.documentElement.dataset['theme']).toBe('dark');
  });

  it('generates its own device id rather than shipping one', () => {
    const { storage } = setup();
    const first = storage.get('to-hoot:device');
    expect(first).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    // Two devices sharing an id would write the same event paths, and the whole
    // merge model rests on them not colliding.
    expect(setup().storage.get('to-hoot:device')).not.toBe(first);
  });

  it('says the day is done once nothing is left, and asks for nothing', async () => {
    const { user, container } = setup();
    await addTask(user, 'Rewire the bench');
    await user.click(screen.getByRole('checkbox', { name: 'Complete Rewire the bench' }));

    const empty = container.querySelector<HTMLElement>('[data-empty]')!;
    expect(empty).toHaveTextContent('Today is done.');
    expect(within(empty).queryByRole('button')).toBeNull();
  });

  it('reports nothing due before anything has been added', () => {
    const { container } = setup();
    expect(container.querySelector('[data-empty]')).toHaveTextContent('Nothing is due today.');
  });

  it('draws the tracked lane from the running timer, before any flush', async () => {
    const { user, container, advance } = setup();
    await addTask(user, 'Rewire the bench');
    await user.click(screen.getByRole('button', { name: /^Start timer/ }));
    advance(5_000);

    // Without this the lane would freeze at the start of every session: the
    // stretch since the last flush is not in the log yet.
    expect(container.querySelector('[data-tracked="pending"]')).not.toBeNull();
  });

  it('keeps tracked against planned in front of the reader at all times', async () => {
    const { user } = setup();
    await addTask(user, 'Rewire the bench');
    expect(screen.getByText('tracked')).toBeInTheDocument();
    expect(screen.getByText('planned')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute(
      'aria-valuetext',
      '0m tracked, nothing planned',
    );
  });

  it('gives every control in the shell an accessible name', () => {
    const { container } = setup();
    for (const control of container.querySelectorAll('button, input, [role="checkbox"]')) {
      expect(control, control.outerHTML).toHaveAccessibleName();
    }
  });
});
