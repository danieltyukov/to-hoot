// The running timer, kept in a file next to the rest of this server's state.
//
// It is not an event: the log records time that was spent, and a timer that is
// still running has spent none of it yet. A file is what makes the timer
// survive the server being restarted between the start and the stop, which is
// ordinary for a stdio server a client launches and kills at will.

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { RunningTimer, TimerStore } from '@to-hoot/core/tools';

function parse(text: string): RunningTimer | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const { taskId, startedAt } = raw as Record<string, unknown>;
  if (typeof taskId !== 'string' || taskId === '') return null;
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) return null;
  return { taskId, startedAt };
}

/**
 * A file-backed timer store.
 *
 * Every read failure reports "no timer running" rather than throwing. A missing
 * file is the normal case, and a corrupt one is a file this server wrote and
 * cannot understand: refusing to answer would make every later tool call fail
 * over a value whose whole purpose is to be discarded on the next stop.
 */
export function fileTimerStore(path: string): TimerStore {
  return {
    async read(): Promise<RunningTimer | null> {
      try {
        return parse(await readFile(path, 'utf8'));
      } catch {
        return null;
      }
    },
    async write(timer: RunningTimer | null): Promise<void> {
      if (timer === null) {
        await rm(path, { force: true });
        return;
      }
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify(timer), 'utf8');
    },
  };
}
