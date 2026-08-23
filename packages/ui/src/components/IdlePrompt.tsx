import { useId, useState } from 'react';
import type { IdleGap, Task } from '@to-hoot/core';

import { formatDuration } from '../format.js';
import './IdlePrompt.css';

export interface IdlePromptProps {
  gap: IdleGap;
  /** The task the gap interrupted, when it still exists. */
  interrupted?: Task | undefined;
  /** Somewhere else the time could have gone. Today's list is the useful set. */
  choices: Task[];
  /** Undefined credits the interrupted task; null discards the time. */
  onResolve: (taskId?: string | null) => void;
}

/*
 * The question at the end of subtract-first idle handling.
 *
 * The time is already out of the totals by the time this appears, which is what
 * makes it safe to leave the question unanswered: nothing on screen is claiming
 * work that did not happen, so ignoring this forever is a valid choice with an
 * honest result.
 *
 * Three answers rather than two, because "was that you?" has three truthful
 * replies: it was this task, it was something else, or it was not work. Offering
 * only yes and no would make one of the three lie.
 */
export function IdlePrompt({ gap, interrupted, choices, onResolve }: IdlePromptProps) {
  const id = useId();
  const [other, setOther] = useState('');
  const elsewhere = choices.filter(t => t.id !== gap.taskId && !t.isDone);

  return (
    <section className="idle" aria-label="Idle time" role="status">
      <p className="idle-lead">
        The timer ran for {formatDuration(gap.ms)} with nothing happening
        {interrupted === undefined ? '' : ` on ${interrupted.title}`}. It has not been counted.
      </p>

      <div className="idle-actions">
        <button type="button" className="button" onClick={() => onResolve()}>
          {interrupted === undefined ? 'Count it' : `Count it to ${interrupted.title}`}
        </button>
        <button type="button" className="button" onClick={() => onResolve(null)}>
          It was a break
        </button>
      </div>

      {elsewhere.length === 0 ? null : (
        <div className="idle-actions">
          <label className="micro" htmlFor={id}>
            Or count it to
          </label>
          <select
            id={id}
            className="field-input"
            value={other}
            onChange={e => {
              const next = e.target.value;
              setOther(next);
              if (next !== '') onResolve(next);
            }}
          >
            <option value="">another task</option>
            {elsewhere.map(task => (
              <option key={task.id} value={task.id}>
                {task.title}
              </option>
            ))}
          </select>
        </div>
      )}
    </section>
  );
}
