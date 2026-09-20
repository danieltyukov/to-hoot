import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  completedPerDay,
  consistency,
  dayStr,
  plannedToday,
  todayTasks,
  taskForCalendarEvent,
  workPeriodsOn,
  trackedToday,
  type State,
  type Task,
} from '@to-hoot/core';

import { ConsistencyGrid } from './components/ConsistencyGrid.js';
import { EMPTY_COPY, EmptyState, TodayState } from './components/EmptyState.js';
import { IdlePrompt } from './components/IdlePrompt.js';
import { ProgressRing } from './components/ProgressRing.js';
import { Sidebar, type View } from './components/Sidebar.js';
import { TaskDetail } from './components/TaskDetail.js';
import { TaskList } from './components/TaskList.js';
import { Timeline } from './components/Timeline.js';
import { ThemeToggle } from './components/ThemeToggle.js';
import { TitleBar } from './components/TitleBar.js';
import { windowGrab } from './components/WindowControls.js';
import { DayGlyph, GearGlyph, ListsGlyph, TasksGlyph } from './icons/glyphs.js';
import { Settings } from './components/Settings/Settings.js';
import { Wizard } from './components/Wizard/Wizard.js';
import { browserHttp, browserStore } from './platform/browser.js';
import type { Span, TimelineEvent } from './components/timeline-layout.js';
import type { Http, Platform } from '@to-hoot/core';
import { SyncController, type SyncStatus } from './sync.js';
import { googleClientFor } from './setup.js';
import { CalendarService, timelineEventsFrom } from './calendar.js';
import type { BridgeEvent } from '@to-hoot/core';
import { formatDuration } from './format.js';
import { Store } from './store.js';
import './App.css';

/** How often the display advances. The log is written far less often; see FLUSH_MS. */
export const TICK_MS = 1000;

/** The consistency grid's window. */
const GRID_DAYS = 14;

/**
 * How long a scheduled task occupies when it carries no estimate.
 *
 * A block of zero height is a block nobody can see or click, so a scheduled task
 * with no estimate would vanish from the very view it was scheduled onto.
 */
const UNESTIMATED_BLOCK_MS = 30 * 60_000;

export type Pane = 'lists' | 'tasks' | 'day';

export interface AppProps {
  store?: Store;
  /** The shell's transport. Defaults to fetch, which the browser build uses. */
  http?: Http;
  /** Absolute path to the built MCP server, for the command the wizard prints. */
  mcpServerPath?: string;
  /**
   * The shell. Used for the resume signal, for the window a desktop draws no
   * title bar for, and for opening a link somewhere that is not this window.
   * Absent in tests and in SSR.
   */
  platform?:
    | Pick<Platform, 'onResume' | 'window' | 'openUrl' | 'kind' | 'oauthLoopback' | 'oauthScheme' | 'claudeCode'>
    | undefined;
  /** The sync controller. Injectable so a test can watch when a sync is asked for. */
  sync?: SyncController;
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
export default function App({
  store: injected,
  http = browserHttp,
  mcpServerPath,
  platform,
  sync: injectedSync,
}: AppProps = {}) {
  // The vault is where settings, secrets and the setup flag live. Without one
  // the wizard would have nowhere to record that it had been finished, and
  // would open again on every start.
  const store = useMemo(() => injected ?? new Store({ vault: browserStore() }), [injected]);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const [view, setView] = useState<View>('today');
  const [pane, setPane] = useState<Pane>('tasks');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  useEffect(() => {
    const id = setInterval(() => store.tick(), TICK_MS);
    return () => clearInterval(id);
  }, [store]);

  /*
   * Sync runs opportunistically: once the log has loaded, on a timer, when the
   * app comes back to the foreground, and shortly after a change.
   *
   * Nothing here fights the platform for background execution, because it does
   * not have to. Every event carries its own timestamp and device, and
   * `timeDelta` carries an increment rather than a total, so a phone that syncs
   * when it is next opened reaches the same state as one that synced on time.
   */
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const sync = useMemo(
    () =>
      injectedSync ??
      new SyncController({
        store,
        http,
        settings: () => store.getSnapshot().settings,
        onStatus: setSyncStatus,
      }),
    [store, http, injectedSync],
  );

  /*
   * Every change to the log is a reason to sync, whoever made it.
   *
   * This used to be a wrapper each handler opted into, with a comment claiming
   * that put it in one place. It did not: it put it in a dozen, and two of them
   * were missed, so an import and a settings change waited out the five minute
   * timer. Watching the log cannot be forgotten, because appending to it is
   * what a change is.
   *
   * Only growth counts. A push truncates the log to what it has not
   * acknowledged, and treating that as a change would schedule a sync in
   * response to a sync.
   */
  const logLength = snapshot.events.length;
  const syncedAt = useRef(logLength);
  useEffect(() => {
    const grew = logLength > syncedAt.current;
    syncedAt.current = logLength;
    if (grew) sync.soon();
  }, [sync, logLength]);

  /*
   * The calendar, at both ends: today's events onto the timeline, and tracked
   * time back onto a separate calendar. Write-back is driven by the ledger
   * rather than by "something changed", so running it on every state change
   * costs nothing when nothing has moved.
   */
  const [calendarEvents, setCalendarEvents] = useState<BridgeEvent[]>([]);
  const calendar = useMemo(
    () =>
      new CalendarService({
        store,
        http,
        settings: () => store.getSnapshot().settings,
        onEvents: setCalendarEvents,
        onSave: patch => store.saveSettings(patch),
      }),
    [store, http],
  );
  // Which Google client this shell signs in with, so refreshed tokens work.
  calendar.googleClient = googleClientFor(platform?.kind);

  useEffect(() => calendar.start(), [calendar]);
  useEffect(() => {
    calendar.syncWriteback(snapshot.state);
  }, [calendar, snapshot.state]);

  // One load per boot. Two effects both called it, so every start did two full
  // disk and vault reads and the second reassigned the log from disk.
  useEffect(() => {
    const stop = sync.start();
    // Belt and braces on the same point: whatever load does, the first sync
    // still runs. It is the only thing that gets unsynced work off this device.
    void store
      .load()
      .catch(() => undefined)
      .then(() => sync.syncNow());
    const off = platform?.onResume(() => void sync.syncNow());
    return () => {
      stop();
      off?.();
    };
  }, [sync, store, platform]);

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

  const colorOf = (taskId: string | undefined): string | undefined =>
    taskId === undefined ? undefined : state.projects[state.tasks[taskId]?.projectId ?? '']?.color;

  // Core keeps the stretches on the state; the colour is the UI's business.
  // State rather than the log, because a push truncates the log and the lane
  // would empty itself a few seconds after every sync.
  const spans: Span[] = workPeriodsOn(state, today).map(span => ({
    id: span.id,
    startMs: span.startMs,
    endMs: span.endMs,
    color: colorOf(span.taskId),
  }));
  // The stretch since the last flush is not in the log yet, so the lane would
  // stop moving the moment a timer started without this.
  if (snapshot.pendingSince !== null && snapshot.runningTaskId !== null) {
    spans.push({
      id: 'pending',
      startMs: snapshot.pendingSince,
      endMs: now,
      color: colorOf(snapshot.runningTaskId),
    });
  }

  // A task with a time on it is a block on the day. This is the only source of
  // events until the calendar bridge lands, and it is what makes the timeline
  // fill up as soon as anything is actually scheduled.
  const scheduled: TimelineEvent[] = Object.values(state.tasks)
    .filter(t => t.dueWithTime !== undefined && dayStr(t.dueWithTime, offsetMs) === today)
    .map(t => ({
      id: t.id,
      taskId: t.id,
      title: t.title,
      startMs: t.dueWithTime!,
      endMs: t.dueWithTime! + (t.timeEstimate > 0 ? t.timeEstimate : UNESTIMATED_BLOCK_MS),
      color: colorOf(t.id),
    }));

  /*
   * The day as the calendar has it, beside the day as the tasks have it. An
   * all-day event is left off: it is a label for the whole day rather than a
   * block within it, and drawing it as one would claim 24 hours of the grid.
   */
  const fromCalendar: TimelineEvent[] = timelineEventsFrom(calendarEvents);

  const events: TimelineEvent[] = [...scheduled, ...fromCalendar];

  /*
   * Pressing a block on the day starts tracking against it.
   *
   * Two kinds of block, one gesture. A scheduled task already has a task, so it
   * simply starts. A meeting has none, so one is made for it and tagged with the
   * event id, which is what makes the second press find the first press's task
   * rather than leaving a second row behind for the same hour.
   *
   * That tag is also what keeps write-back quiet for it: a meeting is already a
   * block on the user's own calendar, and a to-hoot block beside it would draw
   * the same hour twice. See `planWriteback`.
   */
  const trackBlock = (blockId: string): void => {
    const block = events.find(e => e.id === blockId);
    if (block === undefined) return;
    if (block.taskId !== undefined) {
      store.start(block.taskId);
      return;
    }
    const source = calendarEvents.find(e => `cal:${e.id}` === blockId);
    if (source === undefined) return;
    const taskId =
      taskForCalendarEvent(state, source.id)?.id ??
      store.addTask(block.title, {
        calendarEventId: source.id,
        // The meeting's own length, so the ring reads twenty minutes of an hour
        // rather than twenty minutes of nothing.
        timeEstimate: Math.max(0, source.end - source.start),
      });
    store.start(taskId);
  };

  // Which block the running timer belongs to, in the ids the timeline uses.
  const runningTask = snapshot.runningTaskId === null ? undefined : state.tasks[snapshot.runningTaskId];
  const trackingBlockId =
    runningTask === undefined
      ? null
      : runningTask.calendarEventId !== undefined && runningTask.calendarEventId !== ''
        ? `cal:${runningTask.calendarEventId}`
        : runningTask.id;

  const heading = view === 'today' ? 'Today' : titleOf(view, state);
  const selected = selectedId === null ? undefined : state.tasks[selectedId];

  const select = (taskId: string): void => {
    setSelectedId(taskId);
    setPane('tasks');
  };

  /*
   * The window frame, where the shell draws none. The desktop hands one over
   * and the app draws its own title bar with it; the browser and the phone
   * hand over nothing and get nothing, since their chrome is already on
   * screen. The grab lives on the shell around both roots, so the window can
   * be moved and closed from the wizard as well as from the app.
   */
  const frame = platform?.window;
  const framed = frame === undefined ? undefined : '';
  const grab = windowGrab(frame);

  /** What the title bar says the window is showing, as VS Code names the file. */
  const windowTitle = showSettings ? 'Settings' : (selected?.title ?? heading);

  if (!snapshot.setupDone) {
    return (
      <div className="shell" data-framed={framed} onMouseDown={grab}>
        {frame === undefined ? null : <TitleBar frame={frame} title="Setup" />}
        <div className="app-frame">
          <Wizard
            http={http}
            settings={snapshot.settings}
            onSave={patch => store.saveSettings(patch)}
            onDone={() => store.finishSetup()}
            mcpServerPath={mcpServerPath}
            openUrl={platform?.openUrl}
            deviceKind={platform?.kind}
            platform={platform}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="shell" data-framed={framed} onMouseDown={grab}>
      {frame === undefined ? null : <TitleBar frame={frame} title={windowTitle} />}
      <div className="app" data-pane={pane}>
        <div className="pane pane-lists">
          <Sidebar
            projects={projects}
            tags={tags}
            active={view}
            onSelect={next => {
              setView(next);
              setSelectedId(null);
              setPane('tasks');
            }}
            counts={counts}
            onAddProject={title => setView(`project:${store.addProject(title)}`)}
            onAddTag={title => store.addTag(title)}
            footer={
              <div className="sidebar-tools">
                <ThemeToggle theme={snapshot.theme} onChange={t => store.setTheme(t)} />
                <button
                  type="button"
                  className="theme-toggle"
                  aria-pressed={showSettings}
                  onClick={() => {
                    setShowSettings(true);
                    setSelectedId(null);
                    setPane('tasks');
                  }}
                >
                  <GearGlyph className="tool-glyph" />
                  <span>Settings</span>
                </button>
              </div>
            }
          />
        </div>

        {/* The detail replaces the list rather than opening beside it: one
            implementation for the desktop and the phone, and on a desktop the day
            timeline stays visible while a task is being planned. */}
        <div className="pane pane-tasks">
          {showSettings ? (
            <Settings
              http={http}
              settings={snapshot.settings}
              theme={snapshot.theme}
              eventCount={snapshot.events.length}
              onSave={patch => store.saveSettings(patch)}
              onSetTheme={t => store.setTheme(t)}
              syncStatus={syncStatus}
              // Everything, a running timer's held bookkeeping included: the
              // button is a person asking for exactly that.
              onSyncNow={() => sync.syncNow({ everything: true })}
              onForgetDevice={id => void sync.forgetDevice(id)}
              storageError={snapshot.storageError}
              onStartFreshLog={() => void store.startFreshLog()}
              onExport={() => store.exportJson()}
              onImport={text => store.importJson(text)}
              onClose={() => setShowSettings(false)}
              mcpServerPath={mcpServerPath}
              openUrl={platform?.openUrl}
              deviceKind={platform?.kind}
              platform={platform}
            />
          ) : selected === undefined ? (
            <TaskList
              heading={heading}
              tasks={visible}
              projects={state.projects}
              tags={state.tags}
              trackedFor={store.trackedFor}
              runningTaskId={snapshot.runningTaskId}
              onToggleDone={(id, isDone) => store.toggleDone(id, isDone)}
              onStart={id => store.start(id)}
              onStop={() => store.stop()}
              onSelect={select}
              onAdd={title => store.addTask(title, defaultsFor(view, today))}
              notice={
                snapshot.idleGap !== null ? (
                  <IdlePrompt
                    gap={snapshot.idleGap}
                    interrupted={state.tasks[snapshot.idleGap.taskId]}
                    choices={todayTasks(state, now)}
                    onResolve={taskId => store.resolveIdle(taskId)}
                  />
                ) : view === 'today' ? (
                  <TodayState open={open.length} done={done.length} />
                ) : null
              }
              empty={view === 'today' ? null : <EmptyState>{emptyCopyFor(view)}</EmptyState>}
            />
          ) : (
            <TaskDetail
              task={selected}
              state={state}
              tracked={store.trackedFor(selected.id)}
              pendingMs={snapshot.pendingMs}
              today={today}
              runningTaskId={snapshot.runningTaskId}
              onClose={() => setSelectedId(null)}
              onPatch={(id, patch) => store.patchTask(id, patch)}
              onAddSubtask={(parentId, title) => store.addSubtask(parentId, title)}
              onToggleDone={(id, isDone) => store.toggleDone(id, isDone)}
              onStart={id => store.start(id)}
              onStop={() => store.stop()}
              onDelete={id => {
                store.deleteTask(id);
                setSelectedId(null);
              }}
              onSelect={select}
            />
          )}
        </div>

        <div className="pane pane-day">
          <Timeline
            dayStartMs={startOfDay(now, offsetMs)}
            startHour={hourOf(state.settings.workdayStart, 9)}
            endHour={hourOf(state.settings.workdayEnd, 17)}
            now={now}
            events={events}
            tracked={spans}
            trackedTotal={tracked + snapshot.pendingMs}
            plannedTotal={planned}
            onActivateEvent={trackBlock}
            trackingEventId={trackingBlockId}
          />
        </div>

        {/* Both halves are labelled and both carry a number. Unlabelled, a ring
            at zero beside fourteen pale cells reads as a skeleton that never
            finished loading, which is what it looked like before. */}
        <footer className="app-foot">
          <div className="foot-block">
            <ProgressRing tracked={tracked + snapshot.pendingMs} planned={planned} size={34} />
            <div className="foot-lines">
              <span className="micro">today</span>
              <span className="foot-value tabular">
                {planned > 0
                  ? `${formatDuration(tracked + snapshot.pendingMs)} of ${formatDuration(planned)}`
                  : `${formatDuration(tracked + snapshot.pendingMs)} tracked`}
              </span>
            </div>
          </div>

          <div className="foot-lines">
            <span className="micro">last {GRID_DAYS} days</span>
            <ConsistencyGrid
              tracked={consistency(state, GRID_DAYS, now)}
              completed={completedPerDay(state, GRID_DAYS, now)}
              now={now}
              dayOffsetMs={offsetMs}
            />
          </div>
        </footer>

        {/* Glyph over label, which is how every phone draws a tab bar and what
            lets the three read at a glance rather than as three words. */}
        <nav className="tabs" aria-label="Panes">
          {(
            [
              ['lists', 'Lists', <ListsGlyph key="lists" />],
              ['tasks', 'Tasks', <TasksGlyph key="tasks" />],
              ['day', 'Day', <DayGlyph key="day" />],
            ] as const
          ).map(([id, label, glyph]) => (
            <button
              key={id}
              type="button"
              className="tab"
              data-tab={id}
              aria-current={pane === id ? 'page' : undefined}
              onClick={() => setPane(id)}
            >
              <span className="tab-glyph" aria-hidden="true">
                {glyph}
              </span>
              <span>{label}</span>
            </button>
          ))}
        </nav>
      </div>
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

function titleOf(view: View, state: State): string {
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
