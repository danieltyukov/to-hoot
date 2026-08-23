import { useEffect, useId, useState, type CSSProperties, type FormEvent } from 'react';
import { taskTotalTime, type State, type Tag, type Task } from '@to-hoot/core';

import { CheckGlyph, PlayGlyph, StopGlyph } from '../icons/glyphs.js';
import {
  dateInput,
  durationInput,
  formatClock,
  formatDuration,
  fromDateInput,
  isoDuration,
  parseDuration,
} from '../format.js';
import './TaskDetail.css';

export interface TaskDetailProps {
  task: Task;
  state: State;
  /** Tracked milliseconds including subtasks, with any unflushed stretch added. */
  tracked: number;
  /** Time accrued to this task but not yet in the log. See Store.pendingMs. */
  pendingMs?: number;
  /** Today's logical day, so the pending stretch is credited to the right row. */
  today?: string;
  runningTaskId?: string | null;
  onClose: () => void;
  /** A field-level change. The caller turns it into an update event. */
  onPatch: (taskId: string, patch: Record<string, unknown>) => void;
  onAddSubtask: (parentId: string, title: string) => void;
  onToggleDone: (taskId: string, done: boolean) => void;
  onStart: (taskId: string) => void;
  onStop: () => void;
  onDelete: (taskId: string) => void;
  onSelect: (taskId: string) => void;
}

/*
 * Everything about one task, and the only place most of it can be set.
 *
 * The estimate is the reason this view is not optional: planned-against-tracked
 * is the whole idea of the app, and without somewhere to type an estimate the
 * ring can never fill and the day header always reads "of 0m".
 *
 * Fields commit on blur rather than on every keystroke. Every keystroke would be
 * an event in the log, and the log is what syncs: typing a title would push
 * thirty events for one edit.
 */
export function TaskDetail({
  task,
  state,
  tracked,
  pendingMs = 0,
  today,
  runningTaskId = null,
  onClose,
  onPatch,
  onAddSubtask,
  onToggleDone,
  onStart,
  onStop,
  onDelete,
  onSelect,
}: TaskDetailProps) {
  const ids = useId();
  const field = (name: string): string => `${ids}-${name}`;
  const isRunning = runningTaskId === task.id;

  const projects = Object.values(state.projects).filter(p => !p.isArchived);
  const tags = Object.values(state.tags);
  const subtasks = Object.values(state.tasks).filter(t => t.parentId === task.id);
  const parent = task.parentId === undefined ? undefined : state.tasks[task.parentId];

  // Core caps nesting at two levels, so a task that already has a parent cannot
  // take children. Offering the composer anyway would be an action that looks
  // like it worked and did nothing.
  const canNest = task.parentId === undefined;

  /*
   * The unflushed stretch is folded into today's row.
   *
   * Without it this list reads "No time on this yet" while the timer beside it
   * counts up, because the log is only written every thirty seconds. The
   * breakdown and the running total are two readings of the same thing and they
   * have to agree.
   */
  const perDay = { ...task.timeSpentOnDay };
  if (isRunning && today !== undefined && pendingMs > 0) {
    perDay[today] = (perDay[today] ?? 0) + pendingMs;
  }
  const days = Object.entries(perDay)
    .filter(([, ms]) => ms > 0)
    .sort(([a], [b]) => (a < b ? 1 : -1));

  return (
    <section className="detail" aria-label={`Task: ${task.title}`}>
      <header className="detail-head">
        <button type="button" className="detail-back" aria-label="Back to the list" onClick={onClose}>
          <BackGlyph />
        </button>
        <button
          type="button"
          role="checkbox"
          aria-checked={task.isDone}
          aria-label={task.isDone ? `Reopen ${task.title}` : `Complete ${task.title}`}
          className="row-check"
          data-done={task.isDone ? '' : undefined}
          onClick={() => onToggleDone(task.id, !task.isDone)}
        >
          <CheckGlyph />
        </button>
        <button
          type="button"
          className="detail-timer"
          aria-pressed={isRunning}
          aria-label={isRunning ? `Stop timer for ${task.title}` : `Start timer for ${task.title}`}
          onClick={() => (isRunning ? onStop() : onStart(task.id))}
        >
          {isRunning ? <StopGlyph /> : <PlayGlyph />}
          <time className="tabular" dateTime={isoDuration(tracked)}>
            {isRunning ? formatClock(tracked) : formatDuration(tracked)}
          </time>
        </button>
      </header>

      {parent === undefined ? null : (
        <p className="detail-parent">
          <span className="micro">subtask of</span>
          <button type="button" className="detail-link" onClick={() => onSelect(parent.id)}>
            {parent.title}
          </button>
        </p>
      )}

      <div className="detail-body">
        <Committed
          id={field('title')}
          label="Title"
          value={task.title}
          onCommit={value => value.trim() !== '' && onPatch(task.id, { title: value.trim() })}
        />

        <Estimate task={task} id={field('estimate')} onPatch={onPatch} />

        <label className="detail-row" htmlFor={field('project')}>
          <span className="micro">Project</span>
          <select
            id={field('project')}
            className="detail-input"
            value={task.projectId}
            onChange={e => onPatch(task.id, { projectId: e.target.value })}
          >
            {/* Inbox always exists as a destination even before it is a stored
                project, so a task is never left pointing at nothing. */}
            {projects.some(p => p.id === 'inbox') ? null : <option value="inbox">Inbox</option>}
            {projects.map(p => (
              <option key={p.id} value={p.id}>
                {p.title}
              </option>
            ))}
          </select>
        </label>

        <div className="detail-row">
          <span className="micro" id={field('tags-label')}>
            Tags
          </span>
          {tags.length === 0 ? (
            <p className="detail-none">No tags yet. Add one in the sidebar.</p>
          ) : (
            <div className="detail-tags" role="group" aria-labelledby={field('tags-label')}>
              {tags.map(tag => (
                <TagToggle key={tag.id} tag={tag} task={task} onPatch={onPatch} />
              ))}
            </div>
          )}
        </div>

        <Due task={task} id={field('due')} onPatch={onPatch} />

        <label className="detail-row" htmlFor={field('notes')}>
          <span className="micro">Notes</span>
          <CommittedArea
            id={field('notes')}
            value={task.notes ?? ''}
            onCommit={value => onPatch(task.id, { notes: value === '' ? null : value })}
          />
        </label>

        {canNest ? (
          <Subtasks
            task={task}
            subtasks={subtasks}
            state={state}
            onAddSubtask={onAddSubtask}
            onToggleDone={onToggleDone}
            onSelect={onSelect}
          />
        ) : null}

        <div className="detail-row">
          <span className="micro">Tracked</span>
          {days.length === 0 ? (
            <p className="detail-none">No time on this yet.</p>
          ) : (
            <ul className="detail-days">
              {days.map(([day, ms]) => (
                <li key={day} data-tracked-day={day}>
                  <span className="tabular detail-day">{day}</span>
                  <time className="tabular" dateTime={isoDuration(ms)}>
                    {formatDuration(ms)}
                  </time>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="detail-foot">
          <button type="button" className="detail-delete" onClick={() => onDelete(task.id)}>
            Delete task
          </button>
        </div>
      </div>
    </section>
  );
}

/** A text field that reports its value on blur or Enter, not on every keystroke. */
function Committed({
  id,
  label,
  value,
  onCommit,
}: {
  id: string;
  label: string;
  value: string;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  // A change from elsewhere (a sync, an undo) has to reach a field nobody is
  // editing, but must not overwrite what someone is part way through typing.
  useEffect(() => setDraft(value), [value]);

  return (
    <label className="detail-row" htmlFor={id}>
      <span className="micro">{label}</span>
      <input
        id={id}
        className="detail-input"
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={() => onCommit(draft)}
        onKeyDown={e => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') setDraft(value);
        }}
      />
    </label>
  );
}

function CommittedArea({
  id,
  value,
  onCommit,
}: {
  id: string;
  value: string;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <textarea
      id={id}
      className="detail-input detail-notes"
      rows={3}
      value={draft}
      onChange={e => setDraft(e.target.value)}
      onBlur={() => onCommit(draft.trim())}
    />
  );
}

function Estimate({
  task,
  id,
  onPatch,
}: {
  task: Task;
  id: string;
  onPatch: TaskDetailProps['onPatch'];
}) {
  const [draft, setDraft] = useState(() => durationInput(task.timeEstimate));
  const [bad, setBad] = useState(false);
  useEffect(() => setDraft(durationInput(task.timeEstimate)), [task.timeEstimate]);

  const commit = (): void => {
    if (draft.trim() === '') {
      setBad(false);
      onPatch(task.id, { timeEstimate: 0 });
      return;
    }
    const ms = parseDuration(draft);
    if (ms === null) {
      setBad(true);
      return;
    }
    setBad(false);
    onPatch(task.id, { timeEstimate: ms });
  };

  return (
    <label className="detail-row" htmlFor={id}>
      <span className="micro">Estimate</span>
      <input
        id={id}
        className="detail-input tabular"
        placeholder="1h 30m"
        value={draft}
        aria-invalid={bad}
        aria-describedby={bad ? `${id}-error` : undefined}
        onChange={e => {
          setDraft(e.target.value);
          setBad(false);
        }}
        onBlur={commit}
        onKeyDown={e => e.key === 'Enter' && e.currentTarget.blur()}
      />
      {bad ? (
        <span className="detail-error" id={`${id}-error`}>
          Try 1h 30m, 90m or 90.
        </span>
      ) : null}
    </label>
  );
}

function Due({ task, id, onPatch }: { task: Task; id: string; onPatch: TaskDetailProps['onPatch'] }) {
  const scheduled = task.dueWithTime;
  const day = scheduled !== undefined ? dateInput(scheduled) : (task.dueDay ?? '');
  const time =
    scheduled === undefined
      ? ''
      : `${String(new Date(scheduled).getHours()).padStart(2, '0')}:${String(
          new Date(scheduled).getMinutes(),
        ).padStart(2, '0')}`;

  /*
   * dueDay and dueWithTime are mutually exclusive in the model, so this always
   * writes one and clears the other. Sending both and letting replay pick would
   * work today and would be relying on a tiebreak rather than stating intent.
   */
  const commit = (nextDay: string, nextTime: string): void => {
    if (nextDay === '') {
      onPatch(task.id, { dueDay: null, dueWithTime: null });
      return;
    }
    if (nextTime === '') {
      onPatch(task.id, { dueDay: nextDay, dueWithTime: null });
      return;
    }
    const at = fromDateInput(nextDay, nextTime);
    if (at === null) return;
    onPatch(task.id, { dueWithTime: at, dueDay: null });
  };

  return (
    <div className="detail-row">
      <span className="micro">Due</span>
      <div className="detail-due">
        <input
          id={id}
          type="date"
          className="detail-input tabular"
          aria-label="Due date"
          value={day}
          onChange={e => commit(e.target.value, time)}
        />
        <input
          type="time"
          className="detail-input tabular"
          aria-label="Due time"
          value={time}
          disabled={day === ''}
          onChange={e => commit(day, e.target.value)}
        />
      </div>
      {/* A time is what puts it on the timeline, which is not obvious from a
          pair of empty fields. */}
      <span className="detail-hint">A time places it on the day timeline.</span>
    </div>
  );
}

function TagToggle({
  tag,
  task,
  onPatch,
}: {
  tag: Tag;
  task: Task;
  onPatch: TaskDetailProps['onPatch'];
}) {
  const on = task.tagIds.includes(tag.id);
  return (
    <button
      type="button"
      className="tag"
      aria-pressed={on}
      /* The sidebar has a button with this same word on it that navigates to
         the tag. Two controls with one name is an ambiguity for a screen reader
         and an unresolvable selector for the mobile suite, which addresses
         controls by name and nothing else. The visible word is still inside the
         name, so a voice command for what is written on it still works. */
      aria-label={`${tag.title} tag`}
      style={{ '--tag-color': tag.color } as CSSProperties}
      onClick={() =>
        onPatch(task.id, {
          tagIds: on ? task.tagIds.filter(id => id !== tag.id) : [...task.tagIds, tag.id],
        })
      }
    >
      {tag.title}
    </button>
  );
}

function Subtasks({
  task,
  subtasks,
  state,
  onAddSubtask,
  onToggleDone,
  onSelect,
}: {
  task: Task;
  subtasks: Task[];
  state: State;
  onAddSubtask: TaskDetailProps['onAddSubtask'];
  onToggleDone: TaskDetailProps['onToggleDone'];
  onSelect: TaskDetailProps['onSelect'];
}) {
  const [title, setTitle] = useState('');
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    const trimmed = title.trim();
    if (trimmed === '') return;
    onAddSubtask(task.id, trimmed);
    setTitle('');
  };

  return (
    <div className="detail-row">
      <span className="micro">Subtasks</span>
      {subtasks.length === 0 ? null : (
        <ul className="detail-subs">
          {subtasks.map(sub => (
            <li key={sub.id} data-subtask={sub.id}>
              <button
                type="button"
                role="checkbox"
                aria-checked={sub.isDone}
                aria-label={sub.isDone ? `Reopen ${sub.title}` : `Complete ${sub.title}`}
                className="row-check"
                data-done={sub.isDone ? '' : undefined}
                onClick={() => onToggleDone(sub.id, !sub.isDone)}
              >
                <CheckGlyph />
              </button>
              <button type="button" className="detail-link" onClick={() => onSelect(sub.id)}>
                {sub.title}
              </button>
              <time className="tabular detail-sub-time">
                {formatDuration(taskTotalTime(state, sub.id))}
              </time>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={submit}>
        <input
          className="detail-input"
          aria-label="New subtask"
          placeholder="Add a subtask"
          value={title}
          onChange={e => setTitle(e.target.value)}
        />
      </form>
    </div>
  );
}

function BackGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
      <path
        d="M10 3 L5 8 L10 13"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
