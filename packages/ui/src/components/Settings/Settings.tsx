import { useId, useRef, useState, type ReactNode } from 'react';
import {
  VERSION,
  type Http,
  type Platform,
  type PlatformKind,
  type Settings as CoreSettings,
  type Theme,
} from '@to-hoot/core';

import { CalendarGlyph, CloudDeviceGlyph, DesktopGlyph, PhoneGlyph, SparkGlyph, SyncGlyph } from '../../icons/glyphs.js';
import type { SyncDevice, SyncStatus } from '../../sync.js';
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
  /** The shell's way of opening a link, where the host will not follow one. */
  openUrl?: ((url: string) => Promise<void>) | undefined;
  /** What the shell says it is, which is what names this device. */
  deviceKind?: PlatformKind | undefined;
  /** The shell, for how a sign-in comes back to it. */
  platform?: Pick<Platform, 'kind' | 'oauthLoopback' | 'oauthScheme'> | undefined;
  syncStatus?: SyncStatus | null;
  onSyncNow?: () => void;
  /** Set when the log on disk cannot be read or written. */
  storageError?: string | null;
  onStartFreshLog?: () => void;
  /** The clock, injectable so "2 minutes ago" is stable under test. */
  now?: () => number;
}

/*
 * Everything the wizard sets, afterwards, and the few things it does not.
 *
 * One scrolling page of cards. The three connections come first, each a card
 * with a glyph, a status line and one word of action, because "is the phone
 * connected" is the question this screen exists to answer. The connection
 * cards expand into the wizard's own step components rather than a second copy
 * of their fields, so the checks, the masking and the messages cannot drift
 * from what setup said.
 *
 * The Devices card is new and is the answer to "will I see the phone's tasks
 * here": every device that writes to the repository is listed with the last
 * moment it did.
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
  openUrl,
  deviceKind,
  platform,
  syncStatus = null,
  onSyncNow,
  storageError = null,
  onStartFreshLog,
  now = Date.now,
}: SettingsProps) {
  const synced = settings.github.owner !== '' && settings.github.repo !== '';

  return (
    <section className="settings" aria-label="Settings">
      <header className="settings-head" data-window-drag="">
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
        <h3 className="micro settings-group">Connections</h3>

        <Card
          id="sync"
          glyph={<SyncGlyph />}
          title="Sync"
          status={syncSummary(settings, syncStatus, now())}
          connected={synced}
        >
          {syncStatus === null || syncStatus.phase === 'unconfigured' ? null : (
            <div className="settings-status">
              <p className="test-result" role="status" data-status={statusTone(syncStatus)}>
                {syncStatus.detail}
                {syncStatus.at === null ? null : (
                  <span className="test-hint">Last synced {ago(syncStatus.at, now())}.</span>
                )}
              </p>
              {onSyncNow === undefined ? null : (
                <button
                  type="button"
                  className="button"
                  disabled={syncStatus.phase === 'syncing'}
                  onClick={onSyncNow}
                >
                  {syncStatus.phase === 'syncing' ? 'Syncing' : 'Sync now'}
                </button>
              )}
            </div>
          )}
          <StepSync http={http} settings={settings} onSave={onSave} deviceKind={deviceKind} openUrl={openUrl} />
        </Card>

        <Card
          id="calendar"
          glyph={<CalendarGlyph />}
          title="Calendar"
          status={describeCalendar(settings)}
          connected={settings.calendar.execUrl !== '' || settings.calendar.icsUrl !== ''}
        >
          <StepCalendar http={http} settings={settings} onSave={onSave} openUrl={openUrl} platform={platform} />
        </Card>

        <Card
          id="claude"
          glyph={<SparkGlyph />}
          title="Claude"
          status={
            settings.worker.url !== ''
              ? 'Endpoint deployed'
              : settings.worker.base !== ''
                ? 'Endpoint deployed from another device'
                : 'Claude Code only, no endpoint yet'
          }
          connected={settings.worker.url !== '' || settings.worker.base !== ''}
        >
          <StepClaude
            http={http}
            settings={settings}
            onSave={onSave}
            mcpServerPath={mcpServerPath}
            openUrl={openUrl}
            platform={platform}
          />
        </Card>

        {synced ? (
          <Devices
            devices={syncStatus?.devices ?? []}
            thisDevice={settings.deviceId}
            now={now()}
            kind={deviceKind}
          />
        ) : null}

        <h3 className="micro settings-group">Preferences</h3>

        <Card id="appearance" title="Appearance" status={describeAppearance(theme, settings)}>
          <Appearance theme={theme} settings={settings} onSetTheme={onSetTheme} onSave={onSave} />
        </Card>

        <Card id="tracking" title="Tracking" status={describeTracking(settings)}>
          <Tracking settings={settings} onSave={onSave} />
        </Card>

        <h3 className="micro settings-group">Data</h3>

        <Card id="data" title="Data" status={storageError === null ? `${eventCount} events on this device` : 'Not saving'}>
          {storageError === null ? null : (
            <div className="step settings-storage">
              <p className="test-result" role="status" data-status="error">
                {storageError}
                <span className="test-hint">
                  Nothing is being written while this is true, because the file that cannot be read
                  is the only copy of anything that has not synced. What is on screen is in memory
                  only, so export it before closing the app.
                </span>
              </p>
              {onStartFreshLog === undefined ? null : (
                <div className="settings-choice">
                  <button type="button" className="button" onClick={onStartFreshLog}>
                    Start a new log
                  </button>
                  <span className="field-hint">
                    Keeps the unreadable file beside the new one rather than deleting it.
                  </span>
                </div>
              )}
            </div>
          )}
          <Data settings={settings} eventCount={eventCount} onExport={onExport} onImport={onImport} />
        </Card>

        <p className="settings-version micro">ToHoot {VERSION}</p>
      </div>
    </section>
  );
}

/** "2 minutes ago", for a status line. Whole units, because nobody needs more. */
export function ago(then: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

function describeSync(settings: CoreSettings): string {
  if (settings.github.owner === '' || settings.github.repo === '') return 'Not connected';
  return `${settings.github.owner}/${settings.github.repo}`;
}

/** What the collapsed card says, which is where most people will ever read it. */
function syncSummary(settings: CoreSettings, status: SyncStatus | null, now: number): string {
  const where = describeSync(settings);
  if (status === null || status.phase === 'unconfigured') return where;
  const parts = [where];
  if (status.phase === 'error') parts.push('not syncing');
  else if (status.pending > 0) parts.push(`${status.pending} to push`);
  else if (status.at !== null) parts.push(`synced ${ago(status.at, now)}`);
  if (status.devices.length > 0) {
    parts.push(status.devices.length === 1 ? '1 device' : `${status.devices.length} devices`);
  }
  return parts.join(', ');
}

function statusTone(status: SyncStatus): string | undefined {
  if (status.phase === 'ok') return 'ok';
  if (status.phase === 'error') return 'error';
  return undefined;
}

function describeCalendar(settings: CoreSettings): string {
  if (settings.calendar.execUrl !== '') return 'Reading and writing back';
  if (settings.calendar.icsUrl !== '') return 'Read-only feed';
  return 'Not connected';
}

function describeAppearance(theme: Theme, settings: CoreSettings): string {
  const name = theme === 'system' ? 'Matches the system' : theme === 'dark' ? 'Dark' : 'Light';
  return `${name}, workday ${settings.workdayStart} to ${settings.workdayEnd}`;
}

function describeTracking(settings: CoreSettings): string {
  const hours = settings.dayStartOffsetMs / 3_600_000;
  const idle = Math.round(settings.idleThresholdMs / 60_000);
  return `${hours === 0 ? 'Day starts at midnight' : `Day starts ${hours}h past midnight`}, idle after ${idle} min`;
}

/**
 * One card. Collapsed, it is a row a person reads; open, it is the whole
 * component. The header is the toggle and carries the status, so the
 * accessible name of the button is "Sync, someone/to-hoot-data, synced just now".
 */
function Card({
  id,
  glyph,
  title,
  status,
  connected,
  children,
}: {
  id: string;
  glyph?: ReactNode;
  title: string;
  status: string;
  /** Shown as a filled dot beside the status on the connection cards. */
  connected?: boolean | undefined;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="card" data-section={id} data-open={open ? '' : undefined}>
      <button type="button" className="card-toggle" aria-expanded={open} onClick={() => setOpen(o => !o)}>
        {glyph === undefined ? null : (
          <span className="card-glyph" aria-hidden="true">
            {glyph}
          </span>
        )}
        <span className="card-text">
          <span className="card-title">{title}</span>
          <span className="card-status">
            {connected === undefined ? null : (
              <span className="card-dot" data-on={connected ? '' : undefined} aria-hidden="true" />
            )}
            {status}
          </span>
        </span>
        <span className="card-action" aria-hidden="true">
          {open ? 'Close' : connected === false ? 'Set up' : 'Manage'}
        </span>
      </button>
      {open ? <div className="card-body">{children}</div> : null}
    </div>
  );
}

/**
 * Every device that writes to the repository, most recent first.
 *
 * The sync engine reads meta.json on every pull, so this is the repository's
 * own view and not this device's guess. A device that has not written in a
 * while is still here: nothing is ever removed from the registry.
 */
function Devices({
  devices,
  thisDevice,
  now,
  kind,
}: {
  devices: SyncDevice[];
  thisDevice: string;
  now: number;
  kind: PlatformKind | undefined;
}) {
  return (
    <div className="card card-open" data-section="devices">
      <div className="card-toggle card-static">
        <span className="card-text">
          <span className="card-title">Devices</span>
          <span className="card-status">
            {devices.length === 0
              ? 'Every device that syncs to the repository appears here.'
              : `${devices.length} writing to the repository. Their tasks are all on this list.`}
          </span>
        </span>
      </div>
      {devices.length === 0 ? null : (
        <ul className="devices" aria-label="Devices">
          {devices.map(device => (
            <li key={device.id} className="device" data-device={device.id}>
              <span className="device-glyph" aria-hidden="true">
                {glyphFor(device.id, device.id === thisDevice ? kind : undefined)}
              </span>
              <span className="device-name">
                {device.id}
                {device.id === thisDevice ? <span className="device-this">this device</span> : null}
              </span>
              <span className="device-when">
                {device.lastSeen === 0 ? 'never' : `synced ${ago(device.lastSeen, now)}`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A glyph from the name, since the registry does not record what a device is. */
function glyphFor(id: string, kind: PlatformKind | undefined): ReactNode {
  const name = id.toLowerCase();
  if (kind === 'android' || /phone|mobile|pixel|android/.test(name)) return <PhoneGlyph />;
  if (kind === 'desktop' || /desktop|laptop|mac|pc|linux|work|home/.test(name)) return <DesktopGlyph />;
  return <CloudDeviceGlyph />;
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

      <p className="field-hint">
        Changing either of these stops a running timer first, so the seconds since the last
        save are counted under the settings that earned them.
      </p>
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
        <div className="segmented" role="group" aria-labelledby={`${ids}-theme`}>
          {(['light', 'dark', 'system'] as const).map(option => (
            <button
              key={option}
              type="button"
              className="segment"
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
    link.download = `ToHoot-${new Date().toISOString().slice(0, 10)}.json`;
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
