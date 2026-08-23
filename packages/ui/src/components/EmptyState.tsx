import type { ReactNode } from 'react';

import './EmptyState.css';

export interface EmptyStateProps {
  children: ReactNode;
}

/*
 * An empty state is one declarative sentence.
 *
 * Not an illustration, a headline, a subhead and a button. That shape is the
 * tell of a template, and every part of it is doing something unhelpful: the
 * illustration fills the space the missing content would have filled, the
 * subhead explains the headline, and the button asks for work at the one moment
 * there is none. A sentence states the situation and stops.
 */
export function EmptyState({ children }: EmptyStateProps) {
  return (
    <p className="empty prose" data-empty="">
      {children}
    </p>
  );
}

/**
 * The sentence Today is in, or null when Today is not empty.
 *
 * "Today is done." is a terminal state on purpose: it is the one place the app
 * has nothing to ask for, and it says so rather than proposing the next thing.
 */
export function todayMessage(open: number, done: number): string | null {
  if (open > 0) return null;
  return done > 0 ? 'Today is done.' : 'Nothing is due today.';
}

/** Today's empty state, or nothing at all when there is work left. */
export function TodayState({ open, done }: { open: number; done: number }) {
  const message = todayMessage(open, done);
  return message === null ? null : <EmptyState>{message}</EmptyState>;
}

/**
 * The other places a list can be empty. Sentences, in one file, so they stay in
 * one voice.
 *
 * Only what is rendered. Lines for the timeline and for search used to sit here
 * and were tested but never shown: an empty day already reads as an empty day,
 * and there is no search to be empty yet. Copy written ahead of the screen it
 * belongs on is copy nobody has read in place.
 */
export const EMPTY_COPY = {
  project: 'This project has no tasks.',
  tag: 'Nothing carries this tag.',
} as const;
