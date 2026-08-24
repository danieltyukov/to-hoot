import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Http } from '@to-hoot/core';

import App, { TICK_MS } from './App.js';
import { memoryStore } from './platform/browser.js';
import { FLUSH_MS, Store } from './store.js';
import { SyncController } from './sync.js';

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
function setup(options: { http?: Http; settings?: Record<string, unknown> } = {}) {
  const storage = new Map<string, string>();
  let clock = NOW;
  const store = new Store({
    now: () => clock,
    storage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => void storage.set(key, value),
    },
    vault: memoryStore(),
  });
  // Past the wizard. First run is covered separately, below.
  store.finishSetup();
  // Before the render, deliberately: the calendar reads once on mount and then
  // on a ten minute timer, so settings that arrive afterwards are settings the
  // first read never sees.
  if (options.settings !== undefined) store.saveSettings(options.settings);
  const utils = render(<App store={store} http={options.http} />);

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
    expect(screen.getByRole('img', { name: /tracked/ })).toHaveAccessibleName(
      '0m tracked, nothing planned',
    );
  });

  it('labels both halves of the footer and gives each a visible number', () => {
    // Unlabelled, a ring at zero beside fourteen pale cells reads as a
    // skeleton that never finished loading.
    const { container } = setup();
    expect(screen.getByText('today')).toBeInTheDocument();
    expect(screen.getByText('last 14 days')).toBeInTheDocument();
    expect(container.querySelector('.foot-value')).toHaveTextContent('0m tracked');
    expect(container.querySelectorAll('[data-today]')).toHaveLength(1);
  });

  it('opens a task and comes back to the list', async () => {
    const { user, container } = setup();
    await addTask(user, 'Rewire the bench');

    await user.click(screen.getByRole('button', { name: 'Rewire the bench' }));
    expect(container.querySelector('.detail')).not.toBeNull();
    expect(screen.getByLabelText('Title')).toHaveValue('Rewire the bench');

    await user.click(screen.getByRole('button', { name: 'Back to the list' }));
    expect(container.querySelector('.detail')).toBeNull();
    expect(container.querySelector('[data-group="open"]')).not.toBeNull();
  });

  it('an estimate reaches the day header and fills the ring', async () => {
    // The whole planned-against-tracked idea was dead before this: nothing in
    // the product could plan anything, so the ring had no scale to fill against.
    const { user } = setup();
    await addTask(user, 'Rewire the bench');
    await user.click(screen.getByRole('button', { name: 'Rewire the bench' }));

    await user.clear(screen.getByLabelText('Estimate'));
    await user.type(screen.getByLabelText('Estimate'), '2h');
    await user.tab();
    await user.click(screen.getByRole('button', { name: 'Back to the list' }));

    expect(screen.getByText('2h 0m')).toBeInTheDocument();
    const ring = screen.getByRole('progressbar');
    expect(ring).toHaveAttribute('aria-valuemax', String(2 * 3_600_000));
    expect(ring).toHaveAccessibleName('0m tracked of 2h 0m planned');
  });

  it('scheduling a task at a time puts a block on the timeline', async () => {
    const { user, container } = setup();
    await addTask(user, 'Rewire the bench');
    await user.click(screen.getByRole('button', { name: 'Rewire the bench' }));

    await user.clear(screen.getByLabelText('Estimate'));
    await user.type(screen.getByLabelText('Estimate'), '90m');
    await user.tab();
    fireEvent.change(screen.getByLabelText('Due time'), { target: { value: '11:00' } });
    await user.click(screen.getByRole('button', { name: 'Back to the list' }));

    const block = container.querySelector<HTMLElement>('[data-event]')!;
    expect(block).toHaveTextContent('Rewire the bench');
    expect(block).toHaveTextContent('11:00');
    // 90 minutes on a 56px hour, measured from the grid's first hour.
    expect(Number.parseFloat(block.style.height)).toBe(1.5 * 56);
  });

  it('gives a scheduled task with no estimate a block that can still be seen', async () => {
    const { user, container } = setup();
    await addTask(user, 'Rewire the bench');
    await user.click(screen.getByRole('button', { name: 'Rewire the bench' }));
    fireEvent.change(screen.getByLabelText('Due time'), { target: { value: '11:00' } });

    // A zero-height block is a block nobody can see or click, on the very view
    // it was just scheduled onto.
    const block = container.querySelector<HTMLElement>('[data-event]')!;
    expect(Number.parseFloat(block.style.height)).toBe(0.5 * 56);
  });

  it('creates a project and puts a task in it', async () => {
    const { user, store, container } = setup();
    await addTask(user, 'Rewire the bench');

    await user.click(screen.getByRole('button', { name: 'New project' }));
    await user.type(screen.getByLabelText('New project name'), 'Radio{Enter}');

    // Creating it also moves to it, which is where the next task belongs.
    const projectId = Object.keys(store.getSnapshot().state.projects)[0]!;
    expect(container.querySelector(`[data-view="project:${projectId}"]`)).not.toBeNull();
    expect(screen.getByRole('heading', { name: 'Radio' })).toBeInTheDocument();

    await addTask(user, 'Order the enclosure');
    const added = Object.values(store.getSnapshot().state.tasks).find(
      t => t.title === 'Order the enclosure',
    )!;
    expect(added.projectId).toBe(projectId);
  });

  it('assigns an existing task to a project from the detail', async () => {
    const { user, store } = setup();
    await addTask(user, 'Rewire the bench');
    await user.click(screen.getByRole('button', { name: 'New project' }));
    await user.type(screen.getByLabelText('New project name'), 'Radio{Enter}');
    const projectId = Object.keys(store.getSnapshot().state.projects)[0]!;

    await user.click(screen.getByRole('button', { name: /^Today/ }));
    await user.click(screen.getByRole('button', { name: 'Rewire the bench' }));
    await user.selectOptions(screen.getByLabelText('Project'), projectId);

    const task = Object.values(store.getSnapshot().state.tasks)[0]!;
    expect(task.projectId).toBe(projectId);
  });

  it('creates a tag and puts it on a task', async () => {
    const { user, store } = setup();
    await addTask(user, 'Rewire the bench');
    await user.click(screen.getByRole('button', { name: 'New tag' }));
    await user.type(screen.getByLabelText('New tag name'), 'errand{Enter}');

    await user.click(screen.getByRole('button', { name: 'Rewire the bench' }));
    // Named "errand tag" rather than "errand": the sidebar has a button with
    // the same word that navigates instead of assigning.
    await user.click(screen.getByRole('button', { name: 'errand tag' }));

    const tagId = Object.keys(store.getSnapshot().state.tags)[0]!;
    expect(Object.values(store.getSnapshot().state.tasks)[0]!.tagIds).toEqual([tagId]);
  });

  it('tracks a session end to end, from the button to timeSpentOnDay', async () => {
    const { user, store, advance, container } = setup();
    await addTask(user, 'Rewire the bench');
    const taskId = Object.keys(store.getSnapshot().state.tasks)[0]!;

    await user.click(screen.getByRole('button', { name: /^Start timer/ }));
    advance(45_000);

    // On screen while it runs.
    expect(screen.getByText('0:45')).toBeInTheDocument();
    expect(container.querySelector('.lane-tracked [data-tracked]')).not.toBeNull();

    await user.click(screen.getByRole('button', { name: /^Stop timer/ }));

    // And in the day totals afterwards, on the right day.
    const day = new Date(NOW).toISOString().slice(0, 10);
    expect(store.getSnapshot().state.tasks[taskId]!.timeSpentOnDay[day]).toBe(45_000);
    expect(screen.getByText('<1m tracked')).toBeInTheDocument();
  });

  it('keeps the tracked lane after a push truncates the log it was drawn from', async () => {
    // The regression this guards: the lane used to be inferred from the event
    // log, which a push empties. The day's totals survived and its shape did
    // not, so the timeline went blank a few seconds after every sync.
    const { user, store, advance, container } = setup();
    await addTask(user, 'Rewire the bench');

    await user.click(screen.getByRole('button', { name: /^Start timer/ }));
    advance(FLUSH_MS + 45_000);
    await user.click(screen.getByRole('button', { name: /^Stop timer/ }));
    expect(container.querySelectorAll('.lane-tracked [data-tracked]').length).toBeGreaterThan(0);

    const last = store.getSnapshot().events.at(-1)!.id;
    act(() => store.markPushed(last));

    expect(store.getSnapshot().events).toHaveLength(0);
    expect(container.querySelectorAll('.lane-tracked [data-tracked]').length).toBeGreaterThan(0);
  });

  it('shows a subtask under its parent and refuses a third level', async () => {
    const { user, container } = setup();
    await addTask(user, 'Rewire the bench');
    await user.click(screen.getByRole('button', { name: 'Rewire the bench' }));
    await user.type(screen.getByLabelText('New subtask'), 'Order the wire{Enter}');

    // The child can be opened, and offers no composer of its own.
    await user.click(screen.getByRole('button', { name: 'Order the wire' }));
    expect(screen.queryByLabelText('New subtask')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Back to the list' }));
    const rows = [...container.querySelectorAll('[data-group="open"] [data-task]')];
    expect(rows.map(r => r.getAttribute('data-depth'))).toEqual(['0', '1']);
  });

  it('shows the running stretch in the day breakdown, not just on the timer', async () => {
    // The log is written every thirty seconds, so without folding the pending
    // stretch in, the breakdown reads "No time on this yet" while the timer
    // beside it counts up.
    const { user, advance, container } = setup();
    await addTask(user, 'Rewire the bench');
    await user.click(screen.getByRole('button', { name: 'Rewire the bench' }));
    await user.click(screen.getByRole('button', { name: /^Start timer/ }));
    advance(12_000);

    expect(screen.queryByText('No time on this yet.')).toBeNull();
    const day = new Date(NOW).toISOString().slice(0, 10);
    expect(container.querySelector(`[data-tracked-day="${day}"]`)).toHaveTextContent('<1m');
  });

  it('deletes a task and returns to the list', async () => {
    const { user, store, container } = setup();
    await addTask(user, 'Rewire the bench');
    await user.click(screen.getByRole('button', { name: 'Rewire the bench' }));
    await user.click(screen.getByRole('button', { name: 'Delete task' }));

    expect(container.querySelector('.detail')).toBeNull();
    expect(store.getSnapshot().state.tasks).toEqual({});
  });

  it('gives every control in the shell an accessible name', () => {
    const { container } = setup();
    for (const control of container.querySelectorAll('button, input, [role="checkbox"]')) {
      expect(control, control.outerHTML).toHaveAccessibleName();
    }
  });
});

describe('idle time', () => {
  /*
   * Subtract first, then ask. The time is already out of the totals by the time
   * the question appears, so an unanswered prompt leaves honest numbers rather
   * than an inflated day.
   */
  function idleSetup() {
    const storage = new Map<string, string>();
    let clock = NOW;
    const store = new Store({
      now: () => clock,
      storage: {
        getItem: key => storage.get(key) ?? null,
        setItem: (key, value) => void storage.set(key, value),
      },
    });
    store.finishSetup();
    store.saveSettings({ idleThresholdMs: 60_000 });
    const utils = render(<App store={store} />);
    return { ...utils, store, user: userEvent.setup(), away: (ms: number) => (clock += ms) };
  }

  it('asks about a stretch it refused to count', async () => {
    const { user, store, away } = idleSetup();
    await user.type(screen.getByLabelText('New task'), 'Rewire the bench{Enter}');
    const id = Object.keys(store.getSnapshot().state.tasks)[0]!;

    await user.click(screen.getByRole('button', { name: /^Start timer/ }));
    away(30 * 60_000);
    act(() => store.tick());

    expect(screen.getByRole('status', { name: 'Idle time' })).toHaveTextContent(
      'The timer ran for 30m with nothing happening on Rewire the bench. It has not been counted.',
    );
    // And it really has not been counted, which is what makes the question calm.
    expect(store.getSnapshot().state.tasks[id]!.timeSpent).toBe(0);
  });

  it('credits the interrupted task when that is the answer', async () => {
    const { user, store, away } = idleSetup();
    await user.type(screen.getByLabelText('New task'), 'Rewire the bench{Enter}');
    const id = Object.keys(store.getSnapshot().state.tasks)[0]!;

    await user.click(screen.getByRole('button', { name: /^Start timer/ }));
    away(30 * 60_000);
    act(() => store.tick());
    await user.click(screen.getByRole('button', { name: 'Count it to Rewire the bench' }));

    expect(store.getSnapshot().state.tasks[id]!.timeSpent).toBe(30 * 60_000);
    expect(screen.queryByRole('status', { name: 'Idle time' })).toBeNull();
  });

  it('discards it when it was a break', async () => {
    const { user, store, away } = idleSetup();
    await user.type(screen.getByLabelText('New task'), 'Rewire the bench{Enter}');
    const id = Object.keys(store.getSnapshot().state.tasks)[0]!;

    await user.click(screen.getByRole('button', { name: /^Start timer/ }));
    away(30 * 60_000);
    act(() => store.tick());
    await user.click(screen.getByRole('button', { name: 'It was a break' }));

    expect(store.getSnapshot().state.tasks[id]!.timeSpent).toBe(0);
    expect(screen.queryByRole('status', { name: 'Idle time' })).toBeNull();
  });

  it('offers somewhere else the time could have gone', async () => {
    // Three truthful answers, not two: this task, something else, or not work.
    const { user, store, away } = idleSetup();
    await user.type(screen.getByLabelText('New task'), 'Rewire the bench{Enter}');
    await user.type(screen.getByLabelText('New task'), 'Read the datasheet{Enter}');
    const other = Object.values(store.getSnapshot().state.tasks).find(
      t => t.title === 'Read the datasheet',
    )!;

    await user.click(screen.getByRole('button', { name: 'Start timer for Rewire the bench' }));
    away(30 * 60_000);
    act(() => store.tick());
    await user.selectOptions(screen.getByLabelText('Or count it to'), other.id);

    expect(store.getSnapshot().state.tasks[other.id]!.timeSpent).toBe(30 * 60_000);
  });
});

describe('two idle gaps in a row', () => {
  it('asks about the first before the second, and loses neither', async () => {
    /*
     * Gaps queue inside the Tracker. Taking a second while the first was still
     * on screen replaced it, so the first was never asked about and its time
     * was never credited: the exact silent loss subtract-first exists to
     * prevent, and it erred in the direction of quietly discarding work.
     */
    const storage = new Map<string, string>();
    let clock = NOW;
    const store = new Store({
      now: () => clock,
      storage: {
        getItem: k => storage.get(k) ?? null,
        setItem: (k, v) => void storage.set(k, v),
      },
    });
    store.finishSetup();
    store.saveSettings({ idleThresholdMs: 60_000 });
    const user = userEvent.setup();
    render(<App store={store} />);

    await user.type(screen.getByLabelText('New task'), 'Rewire the bench{Enter}');
    await user.type(screen.getByLabelText('New task'), 'Read the datasheet{Enter}');
    const tasks = Object.values(store.getSnapshot().state.tasks);
    const first = tasks.find(t => t.title === 'Rewire the bench')!;
    const second = tasks.find(t => t.title === 'Read the datasheet')!;

    // Two separate stretches, on two different tasks, neither answered yet.
    store.start(first.id);
    clock += 30 * 60_000;
    store.stop();
    store.start(second.id);
    clock += 20 * 60_000;
    act(() => store.stop());

    expect(screen.getByRole('status', { name: 'Idle time' })).toHaveTextContent(
      /30m with nothing happening on Rewire the bench/,
    );

    await user.click(screen.getByRole('button', { name: 'Count it to Rewire the bench' }));
    expect(store.getSnapshot().state.tasks[first.id]!.timeSpent).toBe(30 * 60_000);

    // The second is now asked about rather than having been thrown away.
    expect(screen.getByRole('status', { name: 'Idle time' })).toHaveTextContent(
      /20m with nothing happening on Read the datasheet/,
    );
    await user.click(screen.getByRole('button', { name: 'Count it to Read the datasheet' }));
    expect(store.getSnapshot().state.tasks[second.id]!.timeSpent).toBe(20 * 60_000);
  });
});

describe('every change asks for a sync', () => {
  /*
   * The gap this closes: a wrapper each handler opted into, whose own comment
   * said it put the nudge in one place. It put it in a dozen, import and both
   * settings paths were not among them, and nothing tested any of it, so their
   * changes sat on the device for up to five minutes.
   */
  function watched() {
    const storage = new Map<string, string>();
    const store = new Store({
      now: () => NOW,
      storage: {
        getItem: key => storage.get(key) ?? null,
        setItem: (key, value) => void storage.set(key, value),
      },
    });
    store.finishSetup();
    const sync = new SyncController({
      store,
      http: async () => ({ ok: true, status: 200, headers: {}, text: async () => '{}' }),
      settings: () => store.getSnapshot().settings,
    });
    const soon = vi.spyOn(sync, 'soon').mockImplementation(() => undefined);
    render(<App store={store} sync={sync} />);
    return { store, soon };
  }

  it('asks after a task is added', async () => {
    const { soon } = watched();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('New task'), 'Solder the preamp{Enter}');
    expect(soon).toHaveBeenCalled();
  });

  it('asks after an import, which used to wait out the timer', () => {
    const { store, soon } = watched();
    soon.mockClear();
    act(() => {
      store.importJson(
        JSON.stringify({
          events: [
            {
              id: '01M9IMPORTED00000000000001',
              deviceId: 'phone',
              type: 'create',
              entity: 'task',
              entityId: 'imported-1',
              payload: { title: 'From the other device', projectId: 'inbox' },
              ts: NOW - 3_600_000,
            },
          ],
        }),
      );
    });
    expect(soon).toHaveBeenCalled();
  });

  it('asks after a settings change, which used to wait out the timer', () => {
    const { store, soon } = watched();
    soon.mockClear();
    act(() => {
      store.saveSettings({ workdayStart: '08:00' });
    });
    expect(soon).toHaveBeenCalled();
  });

  it('does not ask again when a push truncates the log', () => {
    // Otherwise a sync is the thing that schedules the next sync.
    const { store, soon } = watched();
    act(() => {
      store.addTask('Solder the preamp');
    });
    soon.mockClear();
    act(() => {
      store.markPushed(store.pending().at(-1)!.id);
    });
    expect(soon).not.toHaveBeenCalled();
  });
});

describe('tracking a meeting straight off the timeline', () => {
  const MEETING = {
    id: 'goog-evt-1',
    calendarId: 'work@example.com',
    title: 'Technical Updates',
    start: NOW + 2 * 3_600_000,
    end: NOW + 2.5 * 3_600_000,
    allDay: false,
  };

  /** A bridge that answers with one meeting and records nothing else. */
  function withMeeting() {
    const written: unknown[] = [];
    const http: Http = async req => {
      const body = JSON.parse(req.body ?? '{}') as Record<string, unknown>;
      if (body['action'] === 'writeLog') written.push(body['entries']);
      const reply =
        body['action'] === 'listEvents'
          ? { ok: true, action: 'listEvents', calendarId: '*', calendarCount: 1, events: [MEETING] }
          : { ok: true, action: body['action'], calendarId: 'log', written: [], deleted: [], missing: [] };
      return { status: 200, headers: {}, text: async () => JSON.stringify(reply) };
    };
    return { http, written };
  }

  async function openWithMeeting() {
    const { http, written } = withMeeting();
    const utils = setup({
      http,
      settings: {
        calendar: { execUrl: 'https://script.google.com/macros/s/AK/exec', secret: 'x'.repeat(40), icsUrl: '' },
      },
    });
    const block = await screen.findByRole('button', { name: /Track time on Technical Updates/ }, { timeout: 3000 });
    return { ...utils, written, block };
  }

  const meetingTask = (store: Store) =>
    Object.values(store.getSnapshot().state.tasks).find(t => t.calendarEventId === MEETING.id);

  it('creates the task and starts its timer on one press', async () => {
    const { user, store, block } = await openWithMeeting();
    await user.click(block);

    const task = meetingTask(store)!;
    expect(task).toBeDefined();
    expect(task.title).toBe('Technical Updates');
    expect(store.getSnapshot().runningTaskId).toBe(task.id);
  });

  it('reuses the same task the next time that meeting is pressed', async () => {
    // Otherwise a meeting stopped and resumed leaves a second task behind, and
    // the time for one meeting is split across two rows.
    const { user, store, block } = await openWithMeeting();
    await user.click(block);
    const first = meetingTask(store)!.id;

    await user.click(screen.getByRole('button', { name: /^Stop timer/ }));
    await user.click(screen.getByRole('button', { name: /Track time on Technical Updates/ }));

    expect(meetingTask(store)!.id).toBe(first);
    expect(Object.values(store.getSnapshot().state.tasks)).toHaveLength(1);
  });

  it('does not write the meeting back to the calendar it came from', async () => {
    const { user, store, advance, written } = await openWithMeeting();
    await user.click(screen.getByRole('button', { name: /Track time on Technical Updates/ }));
    advance(FLUSH_MS + 1_000);

    expect(store.getSnapshot().state.tasks[meetingTask(store)!.id]!.timeSpent).toBeGreaterThan(0);
    // The meeting is already a block on the user's own calendar. A to-hoot
    // block beside it would draw the same hour twice.
    expect(written).toEqual([]);
  });
});
