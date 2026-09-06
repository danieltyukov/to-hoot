import { vi } from 'vitest';
import type { WindowFrame } from '@to-hoot/core';

/**
 * A shell's window frame, with the maximise signal held where a test can pull
 * it. Every call is a spy, so a test can say which of the shell's controls a
 * press reached.
 */
export function fakeFrame(maximized = false) {
  let listener: ((m: boolean) => void) | null = null;
  const frame: WindowFrame = {
    minimize: vi.fn(async () => undefined),
    toggleMaximize: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    isMaximized: vi.fn(async () => maximized),
    onMaximizedChange: vi.fn((cb: (m: boolean) => void) => {
      listener = cb;
      return () => {
        listener = null;
      };
    }),
    startDragging: vi.fn(async () => undefined),
  };
  return {
    frame,
    /** What the shell sends after the window is maximised or restored. */
    fire: (m: boolean): void => {
      listener?.(m);
    },
    listening: (): boolean => listener !== null,
  };
}
