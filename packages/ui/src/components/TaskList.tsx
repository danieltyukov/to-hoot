import { useState, type FormEvent, type ReactNode } from 'react';
import type { Project, Task } from '@to-hoot/core';

import { TaskRow } from './TaskRow.js';
import './TaskList.css';

export interface TaskListProps {
  heading?: string;
  tasks: Task[];
  projects: Record<string, Project>;
  /** Tracked milliseconds for a task, including its subtasks. */
  trackedFor: (taskId: string) => number;
  runningTaskId?: string | null;
  onToggleDone: (taskId: string, done: boolean) => void;
  onStart: (taskId: string) => void;
  onStop: () => void;
  onSelect?: ((taskId: string) => void) | undefined;
  /** Omitted where the list is read-only, which removes the composer entirely. */
  onAdd?: ((title: string) => void) | undefined;
  /** Shown in place of both groups when there is nothing at all. */
  empty?: ReactNode;
}

/**
 * The list, in two groups: what is left, then what is finished.
 *
 * Finished work moves rather than vanishing. A task that disappears the instant
 * it is ticked gives no chance to notice the wrong one was ticked, and the day's
 * completions are half the record the consistency grid is built on.
 */
export function TaskList({
  heading,
  tasks,
  projects,
  trackedFor,
  runningTaskId = null,
  onToggleDone,
  onStart,
  onStop,
  onSelect,
  onAdd,
  empty,
}: TaskListProps) {
  const present = new Set(tasks.map(t => t.id));
  // Subtasks render under their parent when the parent is on this list, and as
  // ordinary rows when it is not: an orphaned indent points at nothing.
  const roots = tasks.filter(t => t.parentId === undefined || !present.has(t.parentId));
  const childrenOf = (id: string): Task[] => tasks.filter(t => t.parentId === id);

  const open = roots.filter(t => !t.isDone);
  const done = roots.filter(t => t.isDone);

  const row = (task: Task, depth: 0 | 1): ReactNode => (
    <TaskRow
      key={task.id}
      task={task}
      project={projects[task.projectId]}
      tracked={trackedFor(task.id)}
      isRunning={runningTaskId === task.id}
      depth={depth}
      onToggleDone={onToggleDone}
      onStart={onStart}
      onStop={onStop}
      onSelect={onSelect}
    />
  );

  const group = (items: Task[]): ReactNode[] =>
    items.flatMap(task => [row(task, 0), ...childrenOf(task.id).map(child => row(child, 1))]);

  return (
    <section className="list" aria-label={heading ?? 'Tasks'}>
      {heading === undefined ? null : (
        <header className="list-head">
          <h2>{heading}</h2>
          <span className="micro">{open.length} left</span>
        </header>
      )}

      {onAdd === undefined ? null : <Composer onAdd={onAdd} />}

      {open.length === 0 && done.length === 0 ? (
        empty
      ) : (
        <>
          <ul className="rows" data-group="open">
            {group(open)}
          </ul>
          {done.length === 0 ? null : (
            <>
              <h3 className="micro list-group">Done</h3>
              <ul className="rows" data-group="done">
                {group(done)}
              </ul>
            </>
          )}
        </>
      )}
    </section>
  );
}

/** One field, submitted with Enter. No button: the field is the affordance. */
function Composer({ onAdd }: { onAdd: (title: string) => void }) {
  const [title, setTitle] = useState('');

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    const trimmed = title.trim();
    if (trimmed === '') return;
    onAdd(trimmed);
    setTitle('');
  };

  return (
    <form className="composer" onSubmit={submit}>
      <input
        className="composer-input"
        aria-label="New task"
        placeholder="Add a task"
        value={title}
        onChange={e => setTitle(e.target.value)}
      />
    </form>
  );
}
