import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { makeFixture } from '../test/fixtures.js';
import { TaskRow } from './TaskRow.js';

function setup(overrides: Partial<Parameters<typeof TaskRow>[0]> = {}) {
  const { state } = makeFixture({
    projects: [{ id: 'p1', title: 'Radio', color: '#3d7350' }],
    tasks: [{ id: 't1', title: 'Solder the preamp', projectId: 'p1', tracked: 4_332_000 }],
  });
  const handlers = {
    onToggleDone: vi.fn(),
    onStart: vi.fn(),
    onStop: vi.fn(),
  };
  const utils = render(
    <ul>
      <TaskRow
        task={state.tasks['t1']!}
        project={state.projects['p1']}
        tracked={4_332_000}
        {...handlers}
        {...overrides}
      />
    </ul>,
  );
  return { ...utils, ...handlers, state };
}

describe('TaskRow', () => {
  it('renders the title, project chip and tracked time', () => {
    const { container } = setup();
    expect(screen.getByText('Solder the preamp')).toBeInTheDocument();
    expect(screen.getByText('Radio')).toBeInTheDocument();
    expect(screen.getByText('1h 12m')).toBeInTheDocument();
    expect(container.querySelector('.row-dot')).toHaveStyle({ background: '#3d7350' });
  });

  it('every icon-only control has an aria-label', () => {
    // Broader than "buttons": the completion control is a checkbox, and the
    // mobile suite addresses every one of these by accessible name alone. A
    // control with no name is not merely awkward, it is unreachable.
    const { container } = setup();
    const controls = [...container.querySelectorAll('button, input, [role="checkbox"]')];
    const iconOnly = controls.filter(c => c.textContent?.trim() === '');
    expect(iconOnly.length).toBeGreaterThan(0);
    for (const control of iconOnly) expect(control).toHaveAccessibleName();
  });

  it('names its controls after the task, not after the action', () => {
    // "Start timer" repeated forty times down a list identifies nothing.
    setup();
    expect(screen.getByRole('button', { name: 'Start timer for Solder the preamp' })).toBeEnabled();
    expect(screen.getByRole('checkbox', { name: 'Complete Solder the preamp' })).toBeEnabled();
  });

  it('durations use tabular numerals so rows do not jitter as time ticks', () => {
    // The class is the hook; styles.test.ts asserts what the class does. jsdom
    // does not compute font-variant-numeric, so splitting it is the only way to
    // check both halves honestly.
    const { container } = setup();
    expect(container.querySelector('.row-time')).toHaveClass('tabular');
  });

  it('counts seconds while running, so a live timer is visibly live', () => {
    setup({ isRunning: true, tracked: 7_000 });
    expect(screen.getByText('0:07')).toBeInTheDocument();
  });

  it('offers stop rather than start once it is the running task', async () => {
    const { onStop, onStart } = setup({ isRunning: true, tracked: 7_000 });
    await userEvent.click(screen.getByRole('button', { name: /^Stop timer/ }));
    expect(onStop).toHaveBeenCalledOnce();
    expect(onStart).not.toHaveBeenCalled();
  });

  it('starts the timer for its own task', async () => {
    const { onStart } = setup();
    await userEvent.click(screen.getByRole('button', { name: /^Start timer/ }));
    expect(onStart).toHaveBeenCalledWith('t1');
  });

  it('reports the completion it wants rather than the state it has', async () => {
    const { onToggleDone } = setup();
    await userEvent.click(screen.getByRole('checkbox'));
    expect(onToggleDone).toHaveBeenCalledWith('t1', true);
  });

  it('hides the tracked time on a task nobody has worked on', () => {
    const { container } = setup({ tracked: 0 });
    expect(container.querySelector('.row-time')).toBeNull();
  });

  it('survives a task whose project has been deleted', () => {
    setup({ project: undefined });
    expect(screen.queryByText('Radio')).toBeNull();
    expect(screen.getByText('Solder the preamp')).toBeInTheDocument();
  });
});
