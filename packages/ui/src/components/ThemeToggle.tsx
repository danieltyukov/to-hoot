import type { Theme } from '@to-hoot/core';

import './ThemeToggle.css';

export interface ThemeToggleProps {
  theme: Theme;
  onChange: (theme: Theme) => void;
}

function prefersDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia !== undefined
    ? window.matchMedia('(prefers-color-scheme: dark)').matches
    : false;
}

/*
 * A pressed/unpressed toggle rather than a three-way control.
 *
 * The name is the visible text and the state is `aria-pressed`, not an
 * aria-label that says something the button does not: a name that disagrees with
 * the words on the control is unusable by anyone driving it by voice.
 *
 * "System" stays reachable, it is simply not on this control: the toggle sets an
 * explicit choice, and settings is where the choice is given back.
 */
export function ThemeToggle({ theme, onChange }: ThemeToggleProps) {
  const isDark = theme === 'dark' || (theme === 'system' && prefersDark());
  return (
    <button
      type="button"
      className="theme-toggle"
      aria-pressed={isDark}
      onClick={() => onChange(isDark ? 'light' : 'dark')}
    >
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
        <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.4" />
        <path d="M8 2 A6 6 0 0 0 8 14 Z" fill="currentColor" />
      </svg>
      <span>Dark mode</span>
    </button>
  );
}
