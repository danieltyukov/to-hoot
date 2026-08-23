import type { Project, Task } from '@to-hoot/core';

import { CheckGlyph, PlayGlyph, StopGlyph } from '../icons/glyphs.js';
import { formatClock, formatDuration, isoDuration } from '../format.js';
import './TaskRow.css';

export interface TaskRowProps {
  task: Task;
  /** Undefined when the task is in a project that has been deleted. */
  project?: Project | undefined;
  /** Tracked milliseconds including subtasks. Derived by the caller. */
  tracked: number;
  isRunning?: boolean;
  /** Subtasks are capped at two levels, so this is 0 or 1. */
  depth?: 0 | 1;
  onToggleDone: (taskId: string, done: boolean) => void;
  onStart: (taskId: string) => void;
  onStop: () => void;
  onSelect?: ((taskId: string) => void) | undefined;
}

/*
 * One line of the task list.
 *
 * Every control here is named for the task it belongs to rather than for what it
 * does. "Start timer" is ambiguous in a list of forty rows, both to a screen
 * reader working down the page and to the mobile test suite, which addresses
 * controls by their accessible name and nothing else.
 */
export function TaskRow({
  task,
  project,
  tracked,
  isRunning = false,
  depth = 0,
  onToggleDone,
  onStart,
  onStop,
  onSelect,
}: TaskRowProps) {
  const done = task.isDone;

  return (
    <li
      className="row"
      data-task={task.id}
      data-done={done ? '' : undefined}
      data-running={isRunning ? '' : undefined}
      data-depth={depth}
    >
      <button
        type="button"
        role="checkbox"
        aria-checked={done}
        aria-label={done ? `Reopen ${task.title}` : `Complete ${task.title}`}
        className="row-check"
        onClick={() => onToggleDone(task.id, !done)}
      >
        <CheckGlyph />
      </button>

      {onSelect ? (
        <button type="button" className="row-title" onClick={() => onSelect(task.id)}>
          {task.title}
        </button>
      ) : (
        <span className="row-title">{task.title}</span>
      )}

      {project ? (
        <span className="row-project" data-project={project.id}>
          <span className="row-dot" style={{ background: project.color }} aria-hidden="true" />
          {project.title}
        </span>
      ) : null}

      {tracked > 0 || isRunning ? (
        <time className="row-time tabular" dateTime={isoDuration(tracked)}>
          {isRunning ? formatClock(tracked) : formatDuration(tracked)}
        </time>
      ) : null}

      <button
        type="button"
        className="row-timer"
        aria-pressed={isRunning}
        aria-label={isRunning ? `Stop timer for ${task.title}` : `Start timer for ${task.title}`}
        onClick={() => (isRunning ? onStop() : onStart(task.id))}
      >
        {isRunning ? <StopGlyph /> : <PlayGlyph />}
      </button>
    </li>
  );
}
