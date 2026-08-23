import { useState } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { State, Task } from '@to-hoot/core';

import { FIXED_NOW, makeFixture } from '../test/fixtures.js';
import { TaskList } from './TaskList.js';

const FIXTURE = {
  projects: [{ id: 'p1', title: 'Radio', color: '#3d7350' }],
  tasks: [
    { id: 't1', title: 'Solder the preamp', projectId: 'p1', tracked: 1_800_000 },
    { id: 't2', title: 'Order the enclosure', projectId: 'p1' },
    { id: 't3', title: 'Cut the front panel', projectId: 'p1', parentId: 't1' },
  ],
};

/**
 * A host that owns the completion state, because completion is a round trip:
 * the row reports the change, something applies it, and the list re-groups from
 * the new state. Asserting against a component that cannot change proves the
 * click fired and nothing else.
 */
function Host({ state, onStart = vi.fn() }: { state: State; onStart?: (id: string) => void }) {
  const [tasks, setTasks] = useState<Task[]>(() => Object.values(state.tasks));
  return (
    <TaskList
      heading="Today"
      tasks={tasks}
      projects={state.projects}
      trackedFor={id => state.tasks[id]?.timeSpent ?? 0}
      onToggleDone={(id, done) =>
        setTasks(prev =>
          prev.map(t => (t.id === id ? { ...t, isDone: done, doneOn: FIXED_NOW } : t)),
        )
      }
      onStart={onStart}
      onStop={vi.fn()}
      onAdd={title =>
        setTasks(prev => [
          ...prev,
          { ...prev[0]!, id: `new-${prev.length}`, title, isDone: false, timeSpent: 0 },
        ])
      }
    />
  );
}

const rowsIn = (group: 'open' | 'done'): HTMLElement =>
  document.querySelector<HTMLElement>(`[data-group="${group}"]`)!;

describe('TaskList', () => {
  it('completing a task strikes it through and moves it to done', async () => {
    const { state } = makeFixture(FIXTURE);
    render(<Host state={state} />);

    expect(within(rowsIn('open')).getByText('Order the enclosure')).toBeInTheDocument();
    expect(document.querySelector('[data-group="done"]')).toBeNull();

    await userEvent.click(screen.getByRole('checkbox', { name: 'Complete Order the enclosure' }));

    const moved = within(rowsIn('done')).getByText('Order the enclosure');
    expect(moved).toBeInTheDocument();
    expect(getComputedStyle(moved).textDecoration).toContain('line-through');
    expect(within(rowsIn('open')).queryByText('Order the enclosure')).toBeNull();
  });

  it('counts what is left, not what is finished', async () => {
    const { state } = makeFixture(FIXTURE);
    render(<Host state={state} />);
    expect(screen.getByText('2 left')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('checkbox', { name: 'Complete Order the enclosure' }));
    expect(screen.getByText('1 left')).toBeInTheDocument();
  });

  it('indents a subtask under its parent', () => {
    const { state } = makeFixture(FIXTURE);
    render(<Host state={state} />);
    const rows = [...rowsIn('open').querySelectorAll('[data-task]')];
    expect(rows.map(r => r.getAttribute('data-task'))).toEqual(['t1', 't3', 't2']);
    expect(rows[1]).toHaveAttribute('data-depth', '1');
  });

  it('renders a subtask flat when its parent is not on this list', () => {
    // Filtering to one project can leave a child without its parent, and an
    // indent pointing at nothing reads as a rendering bug.
    const { state } = makeFixture(FIXTURE);
    const orphan = state.tasks['t3']!;
    render(
      <TaskList
        tasks={[orphan]}
        projects={state.projects}
        trackedFor={() => 0}
        onToggleDone={vi.fn()}
        onStart={vi.fn()}
        onStop={vi.fn()}
      />,
    );
    expect(document.querySelector('[data-task="t3"]')).toHaveAttribute('data-depth', '0');
  });

  it('adds a task from the composer and clears the field', async () => {
    const { state } = makeFixture(FIXTURE);
    render(<Host state={state} />);
    const field = screen.getByLabelText('New task');

    await userEvent.type(field, 'Wind the transformer{Enter}');

    expect(within(rowsIn('open')).getByText('Wind the transformer')).toBeInTheDocument();
    expect(field).toHaveValue('');
  });

  it('ignores an empty submission rather than adding a blank row', async () => {
    const { state } = makeFixture(FIXTURE);
    render(<Host state={state} />);
    const before = rowsIn('open').querySelectorAll('[data-task]').length;

    await userEvent.type(screen.getByLabelText('New task'), '   {Enter}');

    expect(rowsIn('open').querySelectorAll('[data-task]')).toHaveLength(before);
  });

  it('shows the empty state it was given when there is nothing at all', () => {
    render(
      <TaskList
        tasks={[]}
        projects={{}}
        trackedFor={() => 0}
        onToggleDone={vi.fn()}
        onStart={vi.fn()}
        onStop={vi.fn()}
        empty={<p>Nothing due today.</p>}
      />,
    );
    expect(screen.getByText('Nothing due today.')).toBeInTheDocument();
    expect(document.querySelector('[data-group="open"]')).toBeNull();
  });

  it('offers no composer on a read-only list', () => {
    const { state } = makeFixture(FIXTURE);
    render(
      <TaskList
        tasks={Object.values(state.tasks)}
        projects={state.projects}
        trackedFor={() => 0}
        onToggleDone={vi.fn()}
        onStart={vi.fn()}
        onStop={vi.fn()}
      />,
    );
    expect(screen.queryByLabelText('New task')).toBeNull();
  });
});
