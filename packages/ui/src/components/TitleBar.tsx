import type { WindowFrame } from '@to-hoot/core';

import { OwlMark } from '../icons/OwlMark.js';
import { WindowControls } from './WindowControls.js';
import { Wordmark } from './Wordmark.js';
import './TitleBar.css';

export interface TitleBarProps {
  frame: WindowFrame;
  /** What the window is showing: the view, the open task, or Settings. */
  title: string;
}

/*
 * The window's own title bar, for a window the shell draws none for.
 *
 * 0.4.0 took the native decorations away and put the three controls in the far
 * corner of the day pane's header. That left the top edge of the window as
 * three different things: a brand with no rule under it, a heading with one,
 * and a heading with one and a 96px hole reserved at its end. This is the
 * fourth: one strip across the whole window, which is what every frameless
 * application draws and what lets a pane header go back to being a pane header.
 *
 * The shape is VS Code's, because that is the shape the platform's users
 * already read: product at the left, what the window is showing in the middle,
 * controls at the right, the whole strip a drag handle. The palette is not VS
 * Code's. Its close button fills red and puts a white glyph on it, and this app
 * has no token that reads on red in both themes, so close says what it is by
 * turning `--danger` under the pointer instead.
 *
 * Rendered only when the shell hands over a `WindowFrame`, which is the same
 * condition the controls themselves use. A browser tab and an Android activity
 * have chrome already.
 */
export function TitleBar({ frame, title }: TitleBarProps) {
  return (
    <header className="titlebar" data-window-drag="">
      <div className="titlebar-brand">
        <OwlMark size={18} label={null} className="brand-mark" />
        <Wordmark className="brand-word" />
      </div>

      {/*
        Chrome, not content. Every word here is a heading somewhere in the
        window underneath, so announcing it again would read the same thing
        twice to anyone who cannot see that this is a title bar.
      */}
      <p className="titlebar-title" aria-hidden="true">
        <span className="titlebar-where">{title}</span>
        <span className="titlebar-sep">·</span>
        <span>to-hoot</span>
      </p>

      <WindowControls frame={frame} />
    </header>
  );
}
