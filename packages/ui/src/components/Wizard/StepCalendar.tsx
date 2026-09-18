import { useEffect, useId, useRef, useState } from 'react';
import type { Http, Settings } from '@to-hoot/core';
import APPS_SCRIPT_SOURCE from 'virtual:apps-script-source';

import { CopyButton, ExternalLink, Reveal, SecretField, TestConnection, TextField, useCheck } from '../fields.js';
import { generateSecret, testCalendar, testIcs } from '../../setup.js';

export interface StepCalendarProps {
  http: Http;
  settings: Settings;
  onSave: (patch: Partial<Settings>) => void;
  /** The shell's way of opening a link, where the host will not follow one. */
  openUrl?: ((url: string) => Promise<void>) | undefined;
}

/** The property the deployed script reads the secret from. Not a suggestion. */
export const SECRET_PROPERTY = 'TO_HOOT_SECRET';

/** Where a new Apps Script project is made. */
export const APPS_SCRIPT_CREATE = 'https://script.google.com/home/projects/create';
/** Where the secret iCal address of a calendar is found. */
export const GOOGLE_CALENDAR_SETTINGS = 'https://calendar.google.com/calendar/r/settings';

/** A deployment URL, which is the only thing this step still has to be handed. */
const EXEC_URL = /^https:\/\/script\.google\.com\/.*\/exec$/;

/*
 * Calendar.
 *
 * Google requires a person to create and authorise a script, so this step
 * cannot be a single button. What it can be is three numbered stages where the
 * only thing typed is one paste: everything else is a button that opens the
 * right page or copies the right text, and the check runs on its own the moment
 * a deployment URL lands in the field.
 *
 * The secret is NOT substituted into the script source. `clasp push` uploads
 * the source to a Google-hosted project, and the deployed script only ever
 * reads the secret from a Script Property. Baking it into the source would
 * expose it and still not work.
 */
export function StepCalendar({ http, settings, onSave, openUrl }: StepCalendarProps) {
  const ids = useId();
  const field = (name: string): string => `${ids}-${name}`;

  // Generated once, on arrival, and never typed by anyone. A human-chosen
  // secret in front of a public /exec URL is precisely the failure this guards.
  const [secret, setSecret] = useState(() => settings.calendar.secret || generateSecret());
  const [execUrl, setExecUrl] = useState(settings.calendar.execUrl);
  const [icsUrl, setIcsUrl] = useState(settings.calendar.icsUrl);

  const [bridgeState, runBridge] = useCheck();
  const [icsState, runIcs] = useCheck();

  useEffect(() => {
    if (settings.calendar.secret === '') {
      onSave({ calendar: { ...settings.calendar, secret } });
    }
  }, [settings.calendar, secret, onSave]);

  const rotate = (): void => {
    const next = generateSecret();
    setSecret(next);
    onSave({ calendar: { ...settings.calendar, secret: next } });
  };

  const checkBridge = (url: string): Promise<void> =>
    runBridge(async () => {
      const check = await testCalendar(http, url, secret);
      if (check.status === 'ok') {
        onSave({ calendar: { ...settings.calendar, execUrl: url.trim(), secret } });
      }
      return check;
    });

  /*
   * The check runs itself when a deployment URL is pasted. A URL is pasted
   * whole, so a value that suddenly matches the shape is one that was just
   * pasted, and the button underneath stays for anyone who wants to run it
   * again. Keyed on the value, so the same URL is not tested twice.
   */
  const lastAuto = useRef(settings.calendar.execUrl);
  const onExecChange = (value: string): void => {
    setExecUrl(value);
    const trimmed = value.trim();
    if (EXEC_URL.test(trimmed) && lastAuto.current !== trimmed) {
      lastAuto.current = trimmed;
      void checkBridge(trimmed);
    }
  };

  return (
    <div className="step">
      <h2>Your calendar</h2>
      <p className="prose step-lead">
        A small script in your own Google account reads your calendars and writes tracked time back
        to a separate one. Three stages, and only one thing to paste.
      </p>

      <ol className="step-numbered step-stages">
        <li>
          <h4 className="step-stage-head">Make the script</h4>
          <p className="prose">
            Open Apps Script, and replace everything in the editor with the script. Under{' '}
            <strong>Services</strong>, add <strong>Google Calendar API</strong>.
          </p>
          <div className="step-actions">
            <ExternalLink href={APPS_SCRIPT_CREATE} openUrl={openUrl}>
              Open Apps Script
            </ExternalLink>
            <CopyButton text={APPS_SCRIPT_SOURCE} label="Copy the script" />
          </div>
          <Reveal label="Show the script">
            <pre className="copyable-text mono">{APPS_SCRIPT_SOURCE}</pre>
          </Reveal>
        </li>

        <li>
          <h4 className="step-stage-head">Give it the secret</h4>
          <p className="prose">
            In <strong>Project Settings</strong>, add a Script Property named{' '}
            <span className="mono">{SECRET_PROPERTY}</span> with this value.
          </p>
          <SecretField
            id={field('secret')}
            label="Shared secret"
            value={secret}
            readOnly
            hint="Generated here and sent nowhere but your own script. It is deliberately not in the source above."
          />
          <div className="step-actions">
            <button type="button" className="button" onClick={rotate}>
              Generate a new secret
            </button>
            <p className="field-hint">Rotating it means setting {SECRET_PROPERTY} to the new value as well.</p>
          </div>
        </li>

        <li>
          <h4 className="step-stage-head">Deploy it and paste the address</h4>
          <p className="prose">
            <strong>Deploy, New deployment, Web app</strong>, running as you, with access set to
            anyone with the link. Paste the <span className="mono">/exec</span> URL it gives you and
            the check runs by itself.
          </p>
          <TextField
            id={field('exec')}
            label="Deployment URL"
            value={execUrl}
            onChange={onExecChange}
            placeholder="https://script.google.com/macros/s/.../exec"
          />
          <TestConnection
            label="Test calendar"
            state={bridgeState}
            disabled={execUrl.trim() === ''}
            onTest={() => void checkBridge(execUrl)}
          />
          <p className="field-hint">Lists your next seven days, so a pass means it really works.</p>
        </li>
      </ol>

      <hr className="step-rule" />

      <Reveal label="Only show my events, without the script">
        <p className="prose">
          A secret iCal address needs no script and no deployment. It is read-only: your day appears
          on the timeline, but tracked time is not written back.
        </p>
        <div className="step-actions">
          <ExternalLink href={GOOGLE_CALENDAR_SETTINGS} openUrl={openUrl}>
            Open Google Calendar settings
          </ExternalLink>
        </div>
        <TextField
          id={field('ics')}
          label="Secret iCal address"
          value={icsUrl}
          onChange={setIcsUrl}
          placeholder="https://calendar.google.com/calendar/ical/.../basic.ics"
          hint="Settings for a calendar, then Secret address in iCal format."
        />
        <TestConnection
          label="Test feed"
          state={icsState}
          disabled={icsUrl.trim() === ''}
          onTest={() =>
            runIcs(async () => {
              const check = await testIcs(http, icsUrl);
              if (check.status === 'ok') {
                onSave({ calendar: { ...settings.calendar, icsUrl: icsUrl.trim() } });
              }
              return check;
            })
          }
        />
      </Reveal>
    </div>
  );
}
