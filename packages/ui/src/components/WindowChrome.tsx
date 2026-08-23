import { useEffect, useState } from 'react';

import type { ResizeEdge, WindowButton, WindowButtonLayout, WindowChrome } from '@to-hoot/core';

import './WindowChrome.css';

/*
 * The window's own frame, drawn by the app.
 *
 * Only ever rendered when the shell hands over `windowChrome`, which the desktop
 * does and the browser and Android do not. There is deliberately no bar: GNOME
 * apps stopped having a strip of chrome above their content years ago, and
 * replacing a title bar with an identically tall one of our own would have moved
 * the problem rather than solved it. What is left is a drag region with nothing
 * drawn in it and three buttons floating at one end, so the window reads as
 * having no frame at all until you go to move it.
 */

const EDGES: { edge: ResizeEdge; className: string }[] = [
  { edge: 'North', className: 'n' },
  { edge: 'South', className: 's' },
  { edge: 'East', className: 'e' },
  { edge: 'West', className: 'w' },
  { edge: 'NorthWest', className: 'nw' },
  { edge: 'NorthEast', className: 'ne' },
  { edge: 'SouthWest', className: 'sw' },
  { edge: 'SouthEast', className: 'se' },
];

/**
 * Symbolic glyphs, at the weight GNOME draws them.
 *
 * Line caps are square and the strokes sit on whole pixels, because a 1px
 * diagonal with a round cap renders as a grey smudge at this size rather than
 * as a cross.
 */
function Glyph({ kind, maximized }: { kind: WindowButton; maximized: boolean }): React.ReactElement {
  if (kind === 'minimize') {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path d="M4.5 8.5h7" />
      </svg>
    );
  }
  if (kind === 'close') {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
      </svg>
    );
  }
  // Restore is two offset outlines, which is how every desktop says "this will
  // put the window back where it was" without needing a caption.
  return maximized ? (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M5.5 6.5h5v5h-5z" />
      <path d="M7 6.5V5h4.5v4.5H10" />
    </svg>
  ) : (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M4.5 4.5h7v7h-7z" />
    </svg>
  );
}

const LABEL: Record<WindowButton, string> = {
  minimize: 'Minimise',
  maximize: 'Maximise',
  close: 'Close',
};

export interface WindowChromeProps {
  chrome: WindowChrome;
}

export default function WindowFrame({ chrome }: WindowChromeProps): React.ReactElement | null {
  const [layout, setLayout] = useState<WindowButtonLayout | null>(null);
  const [maximized, setMaximized] = useState(false);

  // Read once. The layout is a desktop setting, and someone who changes it
  // mid-session is not the case worth holding a watcher open for.
  useEffect(() => {
    let live = true;
    void chrome.buttons().then(next => {
      if (live) setLayout(next);
    });
    void chrome.isMaximized().then(next => {
      if (live) setMaximized(next);
    });
    return () => {
      live = false;
    };
  }, [chrome]);

  useEffect(() => chrome.onMaximizeChange(setMaximized), [chrome]);

  const act = (button: WindowButton): void => {
    if (button === 'minimize') void chrome.minimize();
    else if (button === 'maximize') void chrome.toggleMaximize();
    else void chrome.close();
  };

  if (layout === null) return null;

  return (
    <>
      {/*
       * The strip that makes the window draggable. `data-tauri-drag-region` is
       * read by the shell, and it has to be the element under the pointer, so
       * this sits above the panes and takes no pointer events of its own beyond
       * the drag the shell starts.
       */}
      <div className="win-drag" data-tauri-drag-region onDoubleClick={() => void chrome.toggleMaximize()} />

      {/*
       * Resize edges. A maximized window is not resizable by dragging, and
       * leaving live handles on one means an invisible 6px band along the screen
       * edge that swallows clicks meant for whatever is behind it.
       */}
      {!maximized &&
        EDGES.map(({ edge, className }) => (
          <div
            key={edge}
            className={`win-resize win-resize-${className}`}
            onPointerDown={event => {
              if (event.button !== 0) return;
              event.preventDefault();
              void chrome.startResize(edge);
            }}
          />
        ))}

      <div className="win-buttons" data-side={layout.side}>
        {layout.order.map(button => (
          <button
            key={button}
            type="button"
            className="win-button"
            data-button={button}
            // The accessible name has to be what a person would call it, because
            // the mobile suite addresses every control by name and "maximize"
            // stops being true the moment the window is maximized.
            aria-label={button === 'maximize' && maximized ? 'Restore' : LABEL[button]}
            onClick={() => act(button)}
          >
            <Glyph kind={button} maximized={maximized} />
          </button>
        ))}
      </div>
    </>
  );
}
