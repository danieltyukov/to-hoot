import { useEffect, useId, useState } from 'react';
import type { Http, Settings } from '@to-hoot/core';
import APPS_SCRIPT_SOURCE from 'virtual:apps-script-source';

import { Copyable, SecretField, TestConnection, TextField, useCheck } from '../fields.js';
import { generateSecret, testCalendar, testIcs } from '../../setup.js';

export interface StepCalendarProps {
  http: Http;
  settings: Settings;
  onSave: (patch: Partial<Settings>) => void;
}

/** The property the deployed script reads the secret from. Not a suggestion. */
export const SECRET_PROPERTY = 'TO_HOOT_SECRET';

/*
 * Calendar.
 *
 * Google requires a person to create and authorise a script, so this step
 * cannot be automated. What it can do is make the person's part mechanical:
 * everything they have to type is generated here and copied, and the check at
 * the end tells them which of the four things went wrong rather than that
 * something did.
 *
 * The secret is NOT substituted into the script source. An earlier draft of the
 * spec said it was, and that was wrong twice over: `clasp push` uploads the
 * source to a Google-hosted project, and the deployed script only ever reads
 * the secret from a Script Property. Baking it into the source would expose it
 * and still not work.
 */
export function StepCalendar({ http, settings, onSave }: StepCalendarProps) {
  const ids = useId();
  const field = (name: string): string => `${ids}-${name}`;

  // Generated once, on arrival, and never typed by anyone. The user is not
  // offered the chance to choose one: a human-chosen secret in front of a
  // public /exec URL is precisely the failure this is guarding against.
  const [secret, setSecret] = useState(() => settings.calendar.secret || generateSecret());
  const [execUrl, setExecUrl] = useState(settings.calendar.execUrl);
  const [icsUrl, setIcsUrl] = useState(settings.calendar.icsUrl);

  const [bridgeState, runBridge] = useCheck();
  const [icsState, runIcs] = useCheck();

  // Persisted as soon as it exists, not only once a check passes. The value is
  // local, it is what the instructions above tell someone to paste, and a
  // secret that survives only a successful test is one that vanishes from the
  // screen someone was copying it from.
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

  return (
    <div className="step">
      <h2>Your calendar</h2>
      <p className="prose step-lead">
        A small script running in your own Google account reads your calendar and writes tracked
        time back to a separate one. Nothing here is shared with anyone.
      </p>

      <ol className="step-numbered">
        <li>
          <p className="prose">
            Open <span className="mono">script.google.com</span>, make a new project, and replace
            everything in the editor with this.
          </p>
          <Copyable text={APPS_SCRIPT_SOURCE} label="Copy the script source" />
        </li>

        <li>
          <p className="prose">
            In <strong>Project Settings</strong>, add a Script Property named{' '}
            <span className="mono">{SECRET_PROPERTY}</span> with this value.
          </p>
          <SecretField
            id={field('secret')}
            label="Shared secret"
            value={secret}
            readOnly
            hint={
              <>
                Generated on this device and never sent anywhere except to your own script. It is
                deliberately not in the source above: the script only ever reads it from this
                property, and source pasted into a Google-hosted project is one more place a
                secret would sit for no benefit.
              </>
            }
          />
          <div className="step-actions">
            <button type="button" className="button" onClick={rotate}>
              Generate a new secret
            </button>
            <p className="field-hint">
              Rotating it means setting {SECRET_PROPERTY} to the new value as well.
            </p>
          </div>
        </li>

        <li>
          <p className="prose">
            Under <strong>Services</strong>, add <strong>Google Calendar API</strong>. Then{' '}
            <strong>Deploy, New deployment, Web app</strong>, running as you, with access set to
            anyone with the link. Paste the <span className="mono">/exec</span> URL it gives you.
          </p>
          <TextField
            id={field('exec')}
            label="Deployment URL"
            value={execUrl}
            onChange={setExecUrl}
            placeholder="https://script.google.com/macros/s/.../exec"
          />
        </li>
      </ol>

      <TestConnection
        label="Test calendar"
        state={bridgeState}
        disabled={execUrl.trim() === ''}
        onTest={() =>
          runBridge(async () => {
            const check = await testCalendar(http, execUrl, secret);
            if (check.status === 'ok') {
              onSave({ calendar: { ...settings.calendar, execUrl: execUrl.trim(), secret } });
            }
            return check;
          })
        }
      />
      <p className="field-hint">Lists your next seven days, so a pass means it really works.</p>

      <hr className="step-rule" />

      <h3 className="micro">Or just show the events</h3>
      <p className="prose">
        A secret iCal address needs no script and no deployment. It is read-only: your day appears
        on the timeline, but tracked time is not written back.
      </p>
      <TextField
        id={field('ics')}
        label="Secret iCal address"
        value={icsUrl}
        onChange={setIcsUrl}
        placeholder="https://calendar.google.com/calendar/ical/.../basic.ics"
        hint="Google Calendar, Settings for a calendar, Secret address in iCal format."
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
    </div>
  );
}
