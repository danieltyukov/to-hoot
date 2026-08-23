// The append-only event log. Every change to state is one of these, and state
// is always the result of replaying them; there is no other write path.

import { ulid } from './models.js';

export type EventType = 'create' | 'update' | 'delete' | 'timeDelta';
export type EntityKind = 'task' | 'project' | 'tag' | 'settings';

export interface Event {
  /** ULID, so the log sorts by creation time. */
  id: string;
  deviceId: string;
  /** The originating device's wall clock, in epoch milliseconds. */
  ts: number;
  type: EventType;
  entity: EntityKind;
  entityId: string;
  /**
   * Shape depends on `type` and `entity`, and it arrives from other devices
   * running other builds, so replay validates every field it reads.
   * `timeDelta` payloads are `{ day: "YYYY-MM-DD", ms: number }` and carry an
   * increment, never a total.
   */
  payload: unknown;
  schemaVersion: number;
}

export const SCHEMA_VERSION = 1;

export const EVENT_TYPES: readonly EventType[] = ['create', 'update', 'delete', 'timeDelta'];
export const ENTITY_KINDS: readonly EntityKind[] = ['task', 'project', 'tag', 'settings'];

export interface NewEventInput {
  deviceId: string;
  type: EventType;
  entity: EntityKind;
  entityId: string;
  payload?: unknown;
  /** Defaults to `Date.now()`. Pass it explicitly when a caller owns the clock. */
  ts?: number;
  id?: string;
}

export function newEvent(input: NewEventInput): Event {
  return {
    id: input.id ?? ulid(),
    deviceId: input.deviceId,
    ts: input.ts ?? Date.now(),
    type: input.type,
    entity: input.entity,
    entityId: input.entityId,
    payload: input.payload ?? {},
    schemaVersion: SCHEMA_VERSION,
  };
}

/**
 * The total order every device agrees on: originating timestamp, then deviceId,
 * then event id. A total order is what makes replay deterministic, so the
 * tiebreakers are not decoration: two devices with the same clock reading must
 * still land on the same sequence.
 */
export function compareEvents(a: Event, b: Event): number {
  const at = Number.isFinite(a.ts) ? a.ts : 0;
  const bt = Number.isFinite(b.ts) ? b.ts : 0;
  if (at !== bt) return at - bt;
  if (a.deviceId !== b.deviceId) return a.deviceId < b.deviceId ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

/** Rejects events that are structurally unusable, rather than throwing on them. */
export function isWellFormed(e: Event): boolean {
  return (
    typeof e?.id === 'string' &&
    typeof e.deviceId === 'string' &&
    typeof e.entityId === 'string' &&
    e.entityId !== '' &&
    EVENT_TYPES.includes(e.type) &&
    ENTITY_KINDS.includes(e.entity)
  );
}
