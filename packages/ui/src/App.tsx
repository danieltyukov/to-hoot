import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import {
  completedPerDay,
  consistency,
  dayStr,
  plannedToday,
  todayTasks,
  trackedToday,
  type Task,
} from '@to-hoot/core';

import { ConsistencyGrid } from './components/ConsistencyGrid.js';
import { EMPTY_COPY, EmptyState, TodayState } from './components/EmptyState.js';
import { ProgressRing } from './components/ProgressRing.js';
import { Sidebar, type View } from './components/Sidebar.js';
import { TaskList } from './components/TaskList.js';
import { Timeline } from './components/Timeline.js';
import { ThemeToggle } from './components/ThemeToggle.js';
import { trackedSpans } from './trackedSpans.js';
import { Store } from './store.js';
import './App.css';

/** How often the display advances. The log is written far less often; see FLUSH_MS. */
export const TICK_MS = 1000;

/** The consistency grid's window. */
const GRID_DAYS = 14;

export type Pane = 'lists' | 'tasks' | 'day';

export interface AppProps {
  store?: Store;
}

/** "09:00" to 9. Anything unparseable falls back, rather than rendering NaN rows. */
function hourOf(hhmm: string, fallback: number): number {
  const hour = Number.parseInt(hhmm.slice(0, 2), 10);
  return Number.isInteger(hour) && hour >= 0 && hour <= 24 ? hour : fallback;
}

function startOfDay(now: number, offsetMs: number): number {
  const d = new Date(now - offsetMs);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() + offsetMs;
}

/*
 * The shell: three panes on a desktop, the same three as tabs on a phone.
 *
 * Same components either way. The panes are not rebuilt for mobile, they are
 * shown one at a time, which is what keeps a fix in the task list from having to
 * be made twice.
 */
export default function App({ store: injected }: AppProps = {}) {
  const store = useMemo(() => injected ?? new Store(), [injected]);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const [view, setView] = useState<View>('today');
  const [pane, setPane] = useState<Pane>('tasks');

  useEffect(() => {
    const id = setInterval(() => store.tick(), TICK_MS);
    return () => clearInterval(id);
  }, [store]);

  // The document element carries the theme, so the choice reaches the tokens
  // and the browser's own form controls at the same time.
  useEffect(() => {
    const root = document.documentElement;
    if (snapshot.theme === 'system') delete root.dataset['theme'];
    else root.dataset['theme'] = snapshot.theme;
  }, [snapshot.theme]);

  const { state, now } = snapshot;
  const offsetMs = state.settings.dayStartOffsetMs;
  const today = dayStr(now, offsetMs);

  const projects = Object.values(state.projects).filter(p => !p.isArchived);
  const tags = Object.values(state.tags);

  const visible = tasksFor(view, state.tasks, () => todayTasks(state, now));
  const open = visible.filter(t => !t.isDone);
  const done = visible.filter(t => t.isDone);

  const counts: Record<string, number> = { today: todayTasks(state, now).filter(t => !t.isDone).length };
  for (const project of projects) {
    counts[`project:${project.id}`] = Object.values(state.tasks).filter(
      t => t.projectId === project.id && !t.isDone,
    ).length;
  }

  const tracked = trackedToday(state, now);
  const planned = plannedToday(state, now);

  const spans = trackedSpans(snapshot.events, today, id => state.projects[state.tasks[id]?.projectId ?? '']?.color);
  // The stretch since the last flush is not in the log yet, so the lane would
  // stop moving the moment a timer started without this.
  if (snapshot.pendingSince !== null && snapshot.runningTaskId !== null) {
    spans.push({
      id: 'pending',
      startMs: snapshot.pendingSince,
      endMs: now,
      color: state.projects[state.tasks[snapshot.runningTaskId]?.projectId ?? '']?.color,
    });
  }

  const heading = view === 'today' ? 'Today' : titleOf(view, state);

  return (
    <div className="app" data-pane={pane}>
      <div className="pane pane-lists">
        <Sidebar
          projects={projects}
          tags={tags}
          active={view}
          onSelect={next => {
            setView(next);
            setPane('tasks');
          }}
          counts={counts}
          footer={<ThemeToggle theme={snapshot.theme} onChange={t => store.setTheme(t)} />}
        />
      </div>

      <div className="pane pane-tasks">
        <TaskList
          heading={heading}
          tasks={visible}
          projects={state.projects}
          trackedFor={store.trackedFor}
          runningTaskId={snapshot.runningTaskId}
          onToggleDone={(id, isDone) => store.toggleDone(id, isDone)}
          onStart={id => store.start(id)}
          onStop={() => store.stop()}
          onAdd={title => store.addTask(title, defaultsFor(view, today))}
          notice={view === 'today' ? <TodayState open={open.length} done={done.length} /> : null}
          empty={view === 'today' ? null : <EmptyState>{emptyCopyFor(view)}</EmptyState>}
        />
      </div>

      <div className="pane pane-day">
        <Timeline
          dayStartMs={startOfDay(now, offsetMs)}
          startHour={hourOf(state.settings.workdayStart, 9)}
          endHour={hourOf(state.settings.workdayEnd, 17)}
          now={now}
          tracked={spans}
          trackedTotal={tracked + snapshot.pendingMs}
          plannedTotal={planned}
        />
      </div>

      <footer className="app-foot">
        <ProgressRing tracked={tracked + snapshot.pendingMs} planned={planned} />
        <ConsistencyGrid
          tracked={consistency(state, GRID_DAYS, now)}
          completed={completedPerDay(state, GRID_DAYS, now)}
          now={now}
          dayOffsetMs={offsetMs}
        />
      </footer>

      <nav className="tabs" aria-label="Panes">
        {(
          [
            ['lists', 'Lists'],
            ['tasks', 'Tasks'],
            ['day', 'Day'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            className="tab"
            data-tab={id}
            aria-current={pane === id ? 'page' : undefined}
            onClick={() => setPane(id)}
          >
            {label}
          </button>
        ))}
      </nav>
    </div>
  );
}

function tasksFor(
  view: View,
  tasks: Record<string, Task>,
  today: () => Task[],
): Task[] {
  if (view === 'today') return today();
  const [kind, id] = splitView(view);
  const all = Object.values(tasks);
  if (kind === 'project') return all.filter(t => t.projectId === id);
  if (kind === 'tag') return all.filter(t => t.tagIds.includes(id));
  return all;
}

function splitView(view: View): [string, string] {
  const at = view.indexOf(':');
  return at === -1 ? [view, ''] : [view.slice(0, at), view.slice(at + 1)];
}

function titleOf(view: View, state: { projects: Record<string, { title: string }>; tags: Record<string, { title: string }> }): string {
  const [kind, id] = splitView(view);
  if (kind === 'project') return state.projects[id]?.title ?? 'Project';
  if (kind === 'tag') return state.tags[id]?.title ?? 'Tag';
  return 'Tasks';
}

/** Today has its own message, from TodayState, which knows whether it is done. */
function emptyCopyFor(view: View): string {
  const [kind] = splitView(view);
  return kind === 'tag' ? EMPTY_COPY.tag : EMPTY_COPY.project;
}

/** A task added inside a view belongs to that view. */
function defaultsFor(view: View, today: string): Record<string, unknown> {
  const [kind, id] = splitView(view);
  if (kind === 'project') return { projectId: id };
  if (kind === 'tag') return { tagIds: [id] };
  return { dueDay: today };
}
