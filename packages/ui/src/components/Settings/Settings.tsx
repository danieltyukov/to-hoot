import { useId, useRef, useState, type ReactNode } from 'react';
import type { Http, Settings as CoreSettings, Theme } from '@to-hoot/core';

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
        <Section title="Sync" summary={describeSync(settings)}>
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
          <Appearance
            theme={theme}
            workdayStart={settings.workdayStart}
            workdayEnd={settings.workdayEnd}
            onSetTheme={onSetTheme}
            onSave={onSave}
          />
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

function Appearance({
  theme,
  workdayStart,
  workdayEnd,
  onSetTheme,
  onSave,
}: {
  theme: Theme;
  workdayStart: string;
  workdayEnd: string;
  onSetTheme: (theme: Theme) => void;
  onSave: (patch: Partial<CoreSettings>) => void;
}) {
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
