import { act, createEvent, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { WindowFrame } from '@to-hoot/core';

import { fakeFrame } from '../test/frame.js';
import { WindowControls, windowGrab } from './WindowControls.js';

describe('WindowControls', () => {
  it('offers the three controls a title bar would have, each with a name', () => {
    const { frame } = fakeFrame();
    render(<WindowControls frame={frame} />);
    const group = screen.getByRole('group', { name: 'Window' });
    const names = [...group.querySelectorAll('button')].map(b => b.getAttribute('aria-label'));
    expect(names).toEqual(['Minimize', 'Maximize', 'Close']);
  });

  it('hands each press to the shell', async () => {
    const { frame } = fakeFrame();
    const user = userEvent.setup();
    render(<WindowControls frame={frame} />);

    await user.click(screen.getByRole('button', { name: 'Minimize' }));
    expect(frame.minimize).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'Maximize' }));
    expect(frame.toggleMaximize).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(frame.close).toHaveBeenCalledTimes(1);
  });

  it('says Restore while the window is maximised, and follows the window from there', async () => {
    // The state is asked for on mount, so a window that comes up maximised
    // does not offer to maximise what already is.
    const { frame, fire } = fakeFrame(true);
    render(<WindowControls frame={frame} />);
    expect(await screen.findByRole('button', { name: 'Restore' })).toBeInTheDocument();

    // And then followed: a restore from the keyboard or the compositor, which
    // never went through this button, still flips its label.
    act(() => fire(false));
    expect(screen.getByRole('button', { name: 'Maximize' })).toBeInTheDocument();
    act(() => fire(true));
    expect(screen.getByRole('button', { name: 'Restore' })).toBeInTheDocument();
  });

  it('stops listening when it unmounts', () => {
    const { frame, listening } = fakeFrame();
    const { unmount } = render(<WindowControls frame={frame} />);
    expect(listening()).toBe(true);
    unmount();
    expect(listening()).toBe(false);
  });
});

describe('windowGrab', () => {
  function mount(frame: WindowFrame | undefined) {
    render(
      <div onMouseDown={windowGrab(frame)}>
        <header data-window-drag="">
          <h2>Today</h2>
          <button type="button">Add</button>
        </header>
        <p>Nothing due.</p>
      </div>,
    );
    return {
      heading: screen.getByText('Today'),
      control: screen.getByRole('button', { name: 'Add' }),
      body: screen.getByText('Nothing due.'),
    };
  }

  it('is no handler at all without a frame', () => {
    // A browser gets nothing to run on every press, not a handler that
    // returns early on every press.
    expect(windowGrab(undefined)).toBeUndefined();
  });

  it('moves the window from a press on the header, text included', () => {
    const { frame } = fakeFrame();
    const { heading } = mount(frame);
    fireEvent.mouseDown(heading, { button: 0, detail: 1 });
    expect(frame.startDragging).toHaveBeenCalledTimes(1);
    expect(frame.toggleMaximize).not.toHaveBeenCalled();
  });

  it('leaves a press on a control inside the header to the control', () => {
    const { frame } = fakeFrame();
    const { control } = mount(frame);
    fireEvent.mouseDown(control, { button: 0, detail: 1 });
    expect(frame.startDragging).not.toHaveBeenCalled();
  });

  it('does nothing outside a header', () => {
    const { frame } = fakeFrame();
    const { body } = mount(frame);
    fireEvent.mouseDown(body, { button: 0, detail: 1 });
    expect(frame.startDragging).not.toHaveBeenCalled();
  });

  it('maximises on a double press, as a title bar does', () => {
    const { frame } = fakeFrame();
    const { heading } = mount(frame);
    fireEvent.mouseDown(heading, { button: 0, detail: 2 });
    expect(frame.toggleMaximize).toHaveBeenCalledTimes(1);
    expect(frame.startDragging).not.toHaveBeenCalled();
  });

  it('answers only the primary button', () => {
    const { frame } = fakeFrame();
    const { heading } = mount(frame);
    fireEvent.mouseDown(heading, { button: 2, detail: 1 });
    expect(frame.startDragging).not.toHaveBeenCalled();
  });

  it('stops the text selection a drag would otherwise carry along', () => {
    const { frame } = fakeFrame();
    const { heading, body } = mount(frame);
    const grab = createEvent.mouseDown(heading, { button: 0, detail: 1 });
    fireEvent(heading, grab);
    expect(grab.defaultPrevented).toBe(true);

    // And only then: a press elsewhere keeps its default, which is how text
    // in the body stays selectable.
    const press = createEvent.mouseDown(body, { button: 0, detail: 1 });
    fireEvent(body, press);
    expect(press.defaultPrevented).toBe(false);
  });
});
