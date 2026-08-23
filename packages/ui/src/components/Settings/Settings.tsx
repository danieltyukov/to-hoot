import { useId, useRef, useState, type ReactNode } from 'react';
import type { Http, Settings as CoreSettings, Theme } from '@to-hoot/core';

import type { SyncStatus } from '../../sync.js';
import { StepCalendar } from '../Wizard/StepCalendar.js';
import { StepClaude } from '../Wizard/StepClaude.js';
import { StepSync } from '../Wizard/StepSync.js';
import './Settings.css';

export interface SettingsProps {
  http: Http;
  settings: CoreSettings;
  theme: Theme;
  /** How many events are in the log, for the Data section. */
  eventCount: number;
  onSave: (patch: Partial<CoreSettings>) => void;
  onSetTheme: (theme: Theme) => void;
  onExport: () => string;
  onImport: (text: string) => { ok: true; added: number } | { ok: false; error: string };
  onClose: () => void;
  mcpServerPath?: string;
  syncStatus?: SyncStatus | null;
  onSyncNow?: () => void;
}

/*
 * Everything the wizard sets, afterwards.
 *
 * The three connection sections render the wizard's own step components rather
 * than reimplementing their fields. That is not only less code: it means the
 * live "Test connection" checks, the masking, the secret rotation and the
 * error messages are the same ones, and cannot drift into a version that says
 * something different from what setup said.
 */
export function Settings({
  http,
  settings,
  theme,
  eventCount,
  onSave,
  onSetTheme,
  onExport,
  onImport,
  onClose,
  mcpServerPath,
  syncStatus = null,
  onSyncNow,
}: SettingsProps) {
  return (
    <section className="settings" aria-label="Settings">
      <header className="settings-head">
        <button type="button" className="detail-back" aria-label="Close settings" onClick={onClose}>
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
            <path
              d="M10 3 L5 8 L10 13"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <h2>Settings</h2>
      </header>

      <div className="settings-body">
        <Section title="Sync" summary={syncSummary(settings, syncStatus)}>
          {syncStatus === null || syncStatus.phase === 'unconfigured' ? null : (
            <div className="step settings-sync">
              <p className="test-result" role="status" data-status={statusTone(syncStatus)}>
                {syncStatus.detail}
                {syncStatus.at === null ? null : (
                  <span className="test-hint">
                    Last synced at {new Date(syncStatus.at).toLocaleTimeString()}.
                  </span>
                )}
              </p>
              {onSyncNow === undefined ? null : (
                <div className="settings-choice">
                  <button
                    type="button"
                    className="button"
                    disabled={syncStatus.phase === 'syncing'}
                    onClick={onSyncNow}
                  >
                    {syncStatus.phase === 'syncing' ? 'Syncing' : 'Sync now'}
                  </button>
                </div>
              )}
            </div>
          )}
          <StepSync http={http} settings={settings} onSave={onSave} />
        </Section>

        <Section title="Calendar" summary={describeCalendar(settings)}>
          <StepCalendar http={http} settings={settings} onSave={onSave} />
        </Section>

        <Section title="Claude" summary={settings.worker.url === '' ? 'Local only' : 'Endpoint configured'}>
          <StepClaude
            http={http}
            settings={settings}
            onSave={onSave}
            mcpServerPath={mcpServerPath}
          />
        </Section>

        <Section title="Appearance" summary={theme}>
          <Appearance theme={theme} settings={settings} onSetTheme={onSetTheme} onSave={onSave} />
        </Section>

        <Section title="Tracking" summary={describeTracking(settings)}>
          <Tracking settings={settings} onSave={onSave} />
        </Section>

        <Section title="Data" summary={`${eventCount} events`}>
          <Data
            settings={settings}
            eventCount={eventCount}
            onExport={onExport}
            onImport={onImport}
          />
        </Section>
      </div>
    </section>
  );
}

function describeSync(settings: CoreSettings): string {
  if (settings.github.owner === '' || settings.github.repo === '') return 'Not configured';
  return `${settings.github.owner}/${settings.github.repo}`;
}

/** What the collapsed row says, which is where most people will ever read it. */
function syncSummary(settings: CoreSettings, status: SyncStatus | null): string {
  const where = describeSync(settings);
  if (status === null || status.phase === 'unconfigured') return where;
  if (status.phase === 'error') return `${where}, not syncing`;
  if (status.pending > 0) return `${where}, ${status.pending} to push`;
  return where;
}

function statusTone(status: SyncStatus): string | undefined {
  if (status.phase === 'ok') return 'ok';
  if (status.phase === 'error') return 'error';
  return undefined;
}

function describeCalendar(settings: CoreSettings): string {
  if (settings.calendar.execUrl !== '') return 'Two-way bridge';
  if (settings.calendar.icsUrl !== '') return 'Read-only feed';
  return 'Not configured';
}

/** Collapsed by default: five open sections is a wall, not a settings screen. */
function Section({
  title,
  summary,
  children,
}: {
  title: string;
  summary: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="settings-section" data-section={title.toLowerCase()}>
      <button
        type="button"
        className="settings-toggle"
        aria-expanded={open}
        onClick={() => setOpen(o => !o)}
      >
        <span className="settings-title">{title}</span>
        <span className="settings-summary">{summary}</span>
      </button>
      {open ? <div className="settings-content">{children}</div> : null}
    </div>
  );
}

function describeTracking(settings: CoreSettings): string {
  const hours = settings.dayStartOffsetMs / 3_600_000;
  const idle = Math.round(settings.idleThresholdMs / 60_000);
  return `${hours === 0 ? 'midnight' : `${hours}h past midnight`}, idle after ${idle}m`;
}

/*
 * The two settings that decide what a tracked second means.
 *
 * Both were stored and honoured and neither had a control, which is the worst
 * of the three states: the behaviour is real, so someone can be surprised by
 * it, and there is nothing to look at to find out why.
 */
function Tracking({
  settings,
  onSave,
}: {
  settings: CoreSettings;
  onSave: (patch: Partial<CoreSettings>) => void;
}) {
  const ids = useId();
  return (
    <div className="step">
      <div className="field">
        <label className="micro" htmlFor={`${ids}-offset`}>
          The day starts at
        </label>
        <select
          id={`${ids}-offset`}
          className="field-input"
          value={String(settings.dayStartOffsetMs)}
          onChange={e => onSave({ dayStartOffsetMs: Number(e.target.value) })}
        >
          {[0, 1, 2, 3, 4, 5, 6].map(hours => (
            <option key={hours} value={hours * 3_600_000}>
              {hours === 0 ? 'Midnight' : `${String(hours).padStart(2, '0')}:00`}
            </option>
          ))}
        </select>
        <p className="field-hint">
          Work done before this counts towards the previous day. If you often finish after
          midnight, move it later and the evening stays on the day it belonged to.
        </p>
      </div>

      <div className="field">
        <label className="micro" htmlFor={`${ids}-idle`}>
          Ask about idle time after
        </label>
        <select
          id={`${ids}-idle`}
          className="field-input"
          value={String(settings.idleThresholdMs)}
          onChange={e => onSave({ idleThresholdMs: Number(e.target.value) })}
        >
          {[2, 5, 10, 15, 30, 60].map(minutes => (
            <option key={minutes} value={minutes * 60_000}>
              {minutes} minutes
            </option>
          ))}
        </select>
        <p className="field-hint">
          A stretch this long with nothing happening is taken back out of the totals and you
          are asked where it went. The numbers stay honest whether or not you answer.
        </p>
      </div>
    </div>
  );
}

function Appearance({
  theme,
  settings,
  onSetTheme,
  onSave,
}: {
  theme: Theme;
  settings: CoreSettings;
  onSetTheme: (theme: Theme) => void;
  onSave: (patch: Partial<CoreSettings>) => void;
}) {
  const { workdayStart, workdayEnd } = settings;
  const ids = useId();
  return (
    <div className="step">
      <div className="field">
        <span className="micro" id={`${ids}-theme`}>
          Theme
        </span>
        <div className="settings-choice" role="group" aria-labelledby={`${ids}-theme`}>
          {(['light', 'dark', 'system'] as const).map(option => (
            <button
              key={option}
              type="button"
              className="button"
              aria-pressed={theme === option}
              onClick={() => onSetTheme(option)}
            >
              {option === 'system' ? 'Match system' : option === 'light' ? 'Light' : 'Dark'}
            </button>
          ))}
        </div>
      </div>

      <div className="field">
        <label className="micro" htmlFor={`${ids}-start`}>
          Workday
        </label>
        <div className="settings-choice">
          <input
            id={`${ids}-start`}
            className="field-input tabular"
            type="time"
            aria-label="Workday start"
            value={workdayStart}
            onChange={e => onSave({ workdayStart: e.target.value })}
          />
          <input
            className="field-input tabular"
            type="time"
            aria-label="Workday end"
            value={workdayEnd}
            onChange={e => onSave({ workdayEnd: e.target.value })}
          />
        </div>
        <p className="field-hint">The hours the day timeline opens on.</p>
      </div>
    </div>
  );
}

function Data({
  settings,
  eventCount,
  onExport,
  onImport,
}: {
  settings: CoreSettings;
  eventCount: number;
  onExport: () => string;
  onImport: SettingsProps['onImport'];
}) {
  const input = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState<string | null>(null);
  const synced = settings.github.owner !== '' && settings.github.repo !== '';

  const download = (): void => {
    const blob = new Blob([onExport()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `to-hoot-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
    setMessage(`Exported ${eventCount} events.`);
  };

  const upload = async (file: File): Promise<void> => {
    const result = onImport(await file.text());
    setMessage(result.ok ? `Merged ${result.added} new events.` : result.error);
  };

  return (
    <div className="step">
      <p className="prose">
        {synced ? (
          <>
            Your data lives on this device and in{' '}
            <span className="mono">
              {settings.github.owner}/{settings.github.repo}
            </span>
            , a private repository on your own GitHub account. Deleting that repository deletes
            the synced history; each device keeps its own copy until it is uninstalled.
          </>
        ) : (
          <>
            Your data lives on this device only. Nothing is sent anywhere. Uninstalling the app,
            or clearing its storage, deletes it, so an export is the only backup.
          </>
        )}
      </p>

      <div className="settings-choice">
        <button type="button" className="button" onClick={download}>
          Export JSON
        </button>
        <button type="button" className="button" onClick={() => input.current?.click()}>
          Import JSON
        </button>
        <input
          ref={input}
          type="file"
          accept="application/json,.json"
          aria-label="Choose a file to import"
          className="visually-hidden"
          onChange={e => {
            const file = e.target.files?.[0];
            if (file !== undefined) void upload(file);
          }}
        />
      </div>
      {message === null ? null : (
        <p className="field-hint" role="status">
          {message}
        </p>
      )}
      <p className="field-hint">
        Importing merges rather than replaces. Events are identified by id, so importing the same
        file twice changes nothing.
      </p>

      <hr className="step-rule" />

      <h3 className="micro">Compaction</h3>
      <p className="prose">
        The log holds {eventCount} events.{' '}
        {synced ? (
          <>
            Sync folds it into a snapshot on its own once it passes the threshold, in the same
            commit that writes the snapshot, so there is never a moment where the two disagree.
            There is nothing to do here by hand.
          </>
        ) : (
          <>
            Compaction happens during sync, which is not set up, so the log simply stays as it is.
            It grows with tracking rather than with tasks: time is written every thirty seconds
            while a timer runs, so two hours a day is around ninety thousand events a year, a few
            tens of megabytes. Export it if that matters to you.
          </>
        )}
      </p>
    </div>
  );
}
