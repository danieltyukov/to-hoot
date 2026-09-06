import { useEffect, useState, type MouseEvent } from 'react';
import type { WindowFrame } from '@to-hoot/core';

import { CloseGlyph, MaximizeGlyph, MinimizeGlyph, RestoreGlyph } from '../icons/glyphs.js';
import './WindowControls.css';

/*
 * The three buttons a title bar would have carried, for a window that has no
 * title bar.
 *
 * The desktop window is undecorated: no native bar, no compositor bar, only
 * the app's own top row. That row is dense with the app's own headings, so the
 * controls sit over its far end rather than in a strip of their own, which is
 * what an extra bar across the top would have been. The pane header under
 * them reserves the width (`--window-controls-w`) so nothing is covered.
 *
 * Rendered only when the shell hands over a `WindowFrame`. In a browser tab or
 * on a phone the host already has chrome, and a second close button inside the
 * page would be a button that closes the wrong thing.
 */

export interface WindowControlsProps {
  frame: WindowFrame;
}

export function WindowControls({ frame }: WindowControlsProps) {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let live = true;
    // Asked once, then followed. The shell has no way to say what the state
    // was before this mounted, and a window restored from a maximised session
    // would otherwise offer to maximise what already is.
    void frame.isMaximized().then(
      m => {
        if (live) setMaximized(m);
      },
      () => undefined,
    );
    const off = frame.onMaximizedChange(setMaximized);
    return () => {
      live = false;
      off();
    };
  }, [frame]);

  return (
    <div className="window-controls" role="group" aria-label="Window">
      <button
        type="button"
        className="window-control"
        aria-label="Minimize"
        onClick={() => void frame.minimize()}
      >
        <MinimizeGlyph />
      </button>
      <button
        type="button"
        className="window-control"
        aria-label={maximized ? 'Restore' : 'Maximize'}
        onClick={() => void frame.toggleMaximize()}
      >
        {maximized ? <RestoreGlyph /> : <MaximizeGlyph />}
      </button>
      <button
        type="button"
        className="window-control window-close"
        aria-label="Close"
        onClick={() => void frame.close()}
      >
        <CloseGlyph />
      </button>
    </div>
  );
}

/**
 * What a press on a drag region must not start a drag from: anything that is
 * itself a control. The same list a native title bar honours, and the same one
 * Tauri's own drag-region script uses, so behaviour matches what a user of any
 * other undecorated window expects.
 */
const CLICKABLE = [
  'a',
  'button',
  'input',
  'select',
  'textarea',
  'label',
  'summary',
  '[contenteditable]:not([contenteditable="false"])',
  '[tabindex]:not([tabindex="-1"])',
  '[role="button"]',
  '[role="link"]',
  '[role="menuitem"]',
  '[role="tab"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="option"]',
].join(', ');

/**
 * The gesture a title bar gives a window: press and drag to move it, press
 * twice to maximise or restore it.
 *
 * One handler on the root, rather than one per header. The pane headers carry
 * `data-window-drag` to say they are the title bar now, and the root decides
 * what a press inside one means. A press on a control inside the header is a
 * press on the control; a press anywhere else in it is a grab. Mouse events
 * rather than pointer events, because `detail` (the click count) is what tells
 * a grab from a double press, and pointer events do not carry it.
 *
 * Returns undefined when there is no frame, so the root has no handler at all
 * in a browser: not a handler that returns early on every press.
 */
export function windowGrab(
  frame: WindowFrame | undefined,
): ((e: MouseEvent<HTMLElement>) => void) | undefined {
  if (frame === undefined) return undefined;
  return e => {
    if (e.button !== 0) return;
    const target = e.target as Element;
    if (target.closest('[data-window-drag]') === null) return;
    if (target.closest(CLICKABLE) !== null) return;
    // The browser would otherwise start a text selection under the pointer,
    // and carry it along for the whole drag.
    e.preventDefault();
    if (e.detail === 2) void frame.toggleMaximize();
    else if (e.detail === 1) void frame.startDragging();
  };
}
