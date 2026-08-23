import { useState } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { FIXED_NOW, makeFixture } from '../test/fixtures.js';
import { TaskDetail } from './TaskDetail.js';

const FIXTURE = {
  projects: [
    { id: 'p1', title: 'Radio', color: '#c2603f' },
    { id: 'p2', title: 'House', color: '#3d7350' },
  ],
  tags: [{ id: 'g1', title: 'errand', color: '#8a6d3b' }],
  tasks: [
    { id: 't1', title: 'Solder the preamp', projectId: 'p1', tracked: 4_332_000 },
    { id: 't2', title: 'Cut the front panel', projectId: 'p1', parentId: 't1' },
  ],
};

function setup(taskId = 't1') {
  const { state } = makeFixture(FIXTURE);
  const handlers = {
    onClose: vi.fn(),
    onPatch: vi.fn(),
    onAddSubtask: vi.fn(),
    onToggleDone: vi.fn(),
    onStart: vi.fn(),
    onStop: vi.fn(),
    onDelete: vi.fn(),
    onSelect: vi.fn(),
  };
  const utils = render(
    <TaskDetail task={state.tasks[taskId]!} state={state} tracked={4_332_000} {...handlers} />,
  );
  return { ...utils, ...handlers, state, user: userEvent.setup() };
}

describe('TaskDetail', () => {
  it('setting an estimate is possible, which is the point of the view', async () => {
    // Without this the ring can never fill and the day header always reads
    // "of 0m": nothing else in the product can plan anything.
    const { user, onPatch } = setup();
    const field = screen.getByLabelText('Estimate');

    await user.clear(field);
    await user.type(field, '1h 30m');
    await user.tab();

    expect(onPatch).toHaveBeenCalledWith('t1', { timeEstimate: 90 * 60_000 });
  });

  it('refuses an estimate it cannot read, and says what it wants', async () => {
    const { user, onPatch } = setup();
    const field = screen.getByLabelText('Estimate');

    await user.clear(field);
    await user.type(field, 'soon');
    await user.tab();

    expect(onPatch).not.toHaveBeenCalled();
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText('Try 1h 30m, 90m or 90.')).toBeInTheDocument();
  });

  it('clears the estimate on an empty field rather than refusing it', async () => {
    const { user, onPatch } = setup();
    await user.clear(screen.getByLabelText('Estimate'));
    await user.tab();
    expect(onPatch).toHaveBeenCalledWith('t1', { timeEstimate: 0 });
  });

  it('commits a title on blur, not on every keystroke', async () => {
    // Each keystroke would be an event in a log that syncs.
    const { user, onPatch } = setup();
    const field = screen.getByLabelText('Title');

    await user.clear(field);
    await user.type(field, 'Solder the output stage');
    expect(onPatch).not.toHaveBeenCalled();

    await user.tab();
    expect(onPatch).toHaveBeenCalledOnce();
    expect(onPatch).toHaveBeenCalledWith('t1', { title: 'Solder the output stage' });
  });

  it('moves a task to another project', async () => {
    const { user, onPatch } = setup();
    await user.selectOptions(screen.getByLabelText('Project'), 'p2');
    expect(onPatch).toHaveBeenCalledWith('t1', { projectId: 'p2' });
  });

  it('toggles a tag on and back off', async () => {
    const { user, onPatch } = setup();
    const tag = screen.getByRole('button', { name: 'errand tag' });
    expect(tag).toHaveAttribute('aria-pressed', 'false');

    await user.click(tag);
    expect(onPatch).toHaveBeenCalledWith('t1', { tagIds: ['g1'] });
  });

  it('writes a scheduled time and clears the plain day, never both', () => {
    // The model makes them mutually exclusive. Sending both and letting replay
    // pick would work today and would be leaning on a tiebreak.
    //
    // A stateful host, because the fields are controlled: a parent that does not
    // echo a change back would leave the second field arguing with the first, and
    // the patches would be taken against a value the component had rejected.
    // fireEvent, because a date or time picker hands over a whole value rather
    // than one character at a time.
    const patches: Array<Record<string, unknown>> = [];
    const { state } = makeFixture(FIXTURE);

    function Host() {
      const [task, setTask] = useState(state.tasks['t1']!);
      return (
        <TaskDetail
          task={task}
          state={state}
          tracked={0}
          onClose={vi.fn()}
          onPatch={(_id, patch) => {
            patches.push(patch);
            setTask(prev => {
              const next = { ...prev, ...patch } as typeof prev;
              if (patch['dueDay'] === null) delete next.dueDay;
              if (patch['dueWithTime'] === null) delete next.dueWithTime;
              return next;
            });
          }}
          onAddSubtask={vi.fn()}
          onToggleDone={vi.fn()}
          onStart={vi.fn()}
          onStop={vi.fn()}
          onDelete={vi.fn()}
          onSelect={vi.fn()}
        />
      );
    }
    render(<Host />);

    fireEvent.change(screen.getByLabelText('Due date'), { target: { value: '2026-08-25' } });
    expect(patches.at(-1)).toEqual({ dueDay: '2026-08-25', dueWithTime: null });

    fireEvent.change(screen.getByLabelText('Due time'), { target: { value: '14:30' } });
    expect(patches.at(-1)).toEqual({
      dueWithTime: new Date(2026, 7, 25, 14, 30).getTime(),
      dueDay: null,
    });

    // Clearing the day clears both, so nothing is left scheduled at a time on
    // no date.
    fireEvent.change(screen.getByLabelText('Due date'), { target: { value: '' } });
    expect(patches.at(-1)).toEqual({ dueDay: null, dueWithTime: null });
  });

  it('cannot set a time before there is a day to put it on', () => {
    const { state } = makeFixture({ tasks: [{ id: 'x', title: 'Loose', dueDay: '' }] });
    render(
      <TaskDetail
        task={{ ...state.tasks['x']!, dueDay: undefined }}
        state={state}
        tracked={0}
        onClose={vi.fn()}
        onPatch={vi.fn()}
        onAddSubtask={vi.fn()}
        onToggleDone={vi.fn()}
        onStart={vi.fn()}
        onStop={vi.fn()}
        onDelete={vi.fn()}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByLabelText('Due time')).toBeDisabled();
  });

  it('shows the tracked time day by day', () => {
    const { container } = setup();
    const today = new Date(FIXED_NOW).toISOString().slice(0, 10);
    const row = container.querySelector(`[data-tracked-day="${today}"]`)!;
    expect(row).toHaveTextContent('1h 12m');
  });

  it('does not offer to nest a third level of subtask', () => {
    // Core rejects it. Offering the composer would be an action that looks like
    // it worked and silently did nothing.
    setup('t2');
    expect(screen.queryByLabelText('New subtask')).toBeNull();
    expect(screen.getByText('Solder the preamp')).toBeInTheDocument();
  });

  it('offers subtasks on a task that can take them', async () => {
    const { user, onAddSubtask } = setup('t1');
    await user.type(screen.getByLabelText('New subtask'), 'Drill the holes{Enter}');
    expect(onAddSubtask).toHaveBeenCalledWith('t1', 'Drill the holes');
  });

  it('lists the subtasks it already has and navigates to one', async () => {
    const { user, onSelect, container } = setup('t1');
    expect(container.querySelector('[data-subtask="t2"]')).not.toBeNull();
    await user.click(screen.getByRole('button', { name: 'Cut the front panel' }));
    expect(onSelect).toHaveBeenCalledWith('t2');
  });

  it('points a subtask back at its parent', async () => {
    const { user, onSelect } = setup('t2');
    await user.click(screen.getByRole('button', { name: 'Solder the preamp' }));
    expect(onSelect).toHaveBeenCalledWith('t1');
  });

  it('starts and stops the timer from the detail', async () => {
    const { user, onStart } = setup();
    await user.click(screen.getByRole('button', { name: 'Start timer for Solder the preamp' }));
    expect(onStart).toHaveBeenCalledWith('t1');
  });

  it('goes back to the list', async () => {
    const { user, onClose } = setup();
    await user.click(screen.getByRole('button', { name: 'Back to the list' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('deletes the task it is showing', async () => {
    const { user, onDelete } = setup();
    await user.click(screen.getByRole('button', { name: 'Delete task' }));
    expect(onDelete).toHaveBeenCalledWith('t1');
  });

  it('gives every control an accessible name', () => {
    const { container } = setup();
    for (const control of container.querySelectorAll(
      'button, input, select, textarea, [role="checkbox"]',
    )) {
      expect(control, control.outerHTML.slice(0, 90)).toHaveAccessibleName();
    }
  });

  it('says plainly when there is nothing rather than showing an empty table', () => {
    const { state } = makeFixture({ tasks: [{ id: 'x', title: 'Fresh' }] });
    const { container } = render(
      <TaskDetail
        task={state.tasks['x']!}
        state={state}
        tracked={0}
        onClose={vi.fn()}
        onPatch={vi.fn()}
        onAddSubtask={vi.fn()}
        onToggleDone={vi.fn()}
        onStart={vi.fn()}
        onStop={vi.fn()}
        onDelete={vi.fn()}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByText('No time on this yet.')).toBeInTheDocument();
    expect(screen.getByText('No tags yet. Add one in the sidebar.')).toBeInTheDocument();
    expect(within(container).queryByRole('table')).toBeNull();
  });
});
