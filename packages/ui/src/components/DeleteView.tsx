import { useEffect, useId, useRef, useState } from 'react';

import { BinGlyph } from '../icons/glyphs.js';
import './DeleteView.css';

export interface DeleteViewProps {
  /** What kind of list this is, for the control names: "Delete project", "Delete tag". */
  noun: 'project' | 'tag';
  title: string;
  /**
   * The whole question, consequences included. The caller writes it, because
   * the caller is the one that knows what goes with the list and what stays.
   */
  question: string;
  onDelete: () => void;
}

/*
 * The way to delete the list on screen, a project or a tag.
 *
 * Two presses, not one. A task is deleted on a single press because a task is
 * one row; a project takes every task filed in it, and that is too much to hang
 * on a control that sits a few pixels from the heading. The first press only
 * asks, and the question says what goes.
 *
 * The question opens in place rather than in a dialog. It belongs to the list
 * it is about, the list stays readable behind it, and there is no overlay to
 * build a second time for the phone.
 *
 * Mount it with a `key` for the view it belongs to, so a question left open on
 * one list is not still open on the next.
 */
export function DeleteView({ noun, title, question, onDelete }: DeleteViewProps) {
  const id = useId();
  const [asking, setAsking] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const backedOut = useRef(false);

  // The question unmounts with the focus inside it. Without this the focus
  // falls to the document, and the next Tab starts from the top of the page.
  useEffect(() => {
    if (asking || !backedOut.current) return;
    backedOut.current = false;
    opener.current?.focus();
  }, [asking]);

  const name = `Delete ${noun} ${title}`;

  if (!asking) {
    return (
      <button
        ref={opener}
        type="button"
        className="view-delete"
        aria-label={name}
        title={`Delete ${noun}`}
        onClick={() => setAsking(true)}
      >
        <BinGlyph />
      </button>
    );
  }

  const cancel = (): void => {
    backedOut.current = true;
    setAsking(false);
  };

  return (
    <div
      className="view-delete-ask"
      role="group"
      aria-label={name}
      aria-describedby={id}
      onKeyDown={e => {
        if (e.key === 'Escape') cancel();
      }}
    >
      <p id={id} className="view-delete-question">
        {question}
      </p>
      <div className="view-delete-actions">
        {/* Cancel takes the focus: an Enter meant for something else keeps the list. */}
        <button type="button" className="button" autoFocus onClick={cancel}>
          Cancel
        </button>
        <button type="button" className="button view-delete-confirm" onClick={onDelete}>
          Delete {noun}
        </button>
      </div>
    </div>
  );
}
