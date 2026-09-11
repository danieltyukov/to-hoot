import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { fakeFrame } from '../test/frame.js';
import { TitleBar } from './TitleBar.js';
import { windowGrab } from './WindowControls.js';

describe('TitleBar', () => {
  it('carries the brand, what the window is showing, and the three controls', () => {
    const { frame } = fakeFrame();
    const { container } = render(<TitleBar frame={frame} title="Today" />);

    expect(container.querySelector('.brand-word')).toHaveTextContent('to-hoot');
    expect(container.querySelector('.titlebar-where')).toHaveTextContent('Today');
    const group = screen.getByRole('group', { name: 'Window' });
    expect(within(group).getAllByRole('button').map(b => b.getAttribute('aria-label'))).toEqual([
      'Minimize',
      'Maximize',
      'Close',
    ]);
  });

  it('keeps the title out of the reading order', () => {
    // It names what the panes underneath already head. Announced, it would say
    // the same word twice before anything with content in it.
    const { frame } = fakeFrame();
    const { container } = render(<TitleBar frame={frame} title="Today" />);
    expect(container.querySelector('.titlebar-title')).toHaveAttribute('aria-hidden', 'true');
    // The brand is not hidden: it is the product's name, said once.
    expect(container.querySelector('.brand-word')).not.toHaveAttribute('aria-hidden');
  });

  it('is a drag region, and its controls are not', () => {
    const { frame } = fakeFrame();
    const { container } = render(
      <div onMouseDown={windowGrab(frame)}>
        <TitleBar frame={frame} title="Today" />
      </div>,
    );

    fireEvent.mouseDown(container.querySelector('.titlebar-where')!, { button: 0, detail: 1 });
    expect(frame.startDragging).toHaveBeenCalledTimes(1);

    // A press on a control is a press on the control, never a grab.
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Minimize' }), {
      button: 0,
      detail: 1,
    });
    expect(frame.startDragging).toHaveBeenCalledTimes(1);
  });
});
