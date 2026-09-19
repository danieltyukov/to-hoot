import { useEffect, useId, useRef, useState } from 'react';
import { EMPTY_GOOGLE_ACCESS, GoogleCalendarClient, type Http, type Platform, type Settings } from '@to-hoot/core';
import APPS_SCRIPT_SOURCE from 'virtual:apps-script-source';

import {
  CopyButton,
  ExternalLink,
  Flow,
  FlowStep,
  Reveal,
  SecretField,
  TestConnection,
  TextField,
  useCheck,
  type FlowStatus,
} from '../fields.js';
import {
  exchangeGoogleCode,
  generateSecret,
  googleAuthUrl,
  googleClientFor,
  newOAuthAttempt,
  readCallback,
  revokeGoogleGrant,
  testCalendar,
  testIcs,
} from '../../setup.js';

export interface StepCalendarProps {
  http: Http;
  settings: Settings;
  onSave: (patch: Partial<Settings>) => void;
  /** The shell's way of opening a link, where the host will not follow one. */
  openUrl?: ((url: string) => Promise<void>) | undefined;
  /** The shell, for what kind it is and how a sign-in comes back to it. */
  platform?: Pick<Platform, 'kind' | 'oauthLoopback' | 'oauthScheme'> | undefined;
}

/** The property the deployed script reads the secret from. Not a suggestion. */
export const SECRET_PROPERTY = 'TO_HOOT_SECRET';

/** Where a new Apps Script project is made. */
export const APPS_SCRIPT_CREATE = 'https://script.google.com/home/projects/create';
/** Where the secret iCal address of a calendar is found. */
export const GOOGLE_CALENDAR_SETTINGS = 'https://calendar.google.com/calendar/r/settings';

/** A deployment URL, which is the only thing the bridge path still has to be handed. */
const EXEC_URL = /^https:\/\/script\.google\.com\/.*\/exec$/;

type Stage = { status: FlowStatus; detail?: string; hint?: string };

/*
 * Calendar.
 *
 * One button: Sign in with Google. The browser opens on Google's own consent
 * page, the person approves, and the app reads and writes their calendar
 * directly with the grant it gets back. Nothing is pasted, no script is
 * deployed, and the "to-hoot log" calendar is made on first write exactly as
 * the script used to make it.
 *
 * The two older routes stay, folded away: a read-only iCal address for someone
 * who only wants to see their day, and the Apps Script bridge for a deployment
 * that already exists. Signing in with Google takes precedence over both.
 */
export function StepCalendar({ http, settings, onSave, openUrl, platform }: StepCalendarProps) {
  const ids = useId();
  const field = (name: string): string => `${ids}-${name}`;

  const google = settings.calendar.google;
  const signedIn = google.refreshToken !== '';
  const client = googleClientFor(platform?.kind);
  const listener =
    platform?.oauthLoopback !== undefined && client?.scheme === undefined
      ? platform.oauthLoopback()
      : platform?.oauthScheme !== undefined && client?.scheme !== undefined
        ? platform.oauthScheme(client.scheme)
        : null;
  const canSignIn = client !== null && listener !== null;

  const [signIn, setSignIn] = useState<Stage>(
    signedIn ? { status: 'ok', detail: `Signed in as ${google.email || 'your Google account'}.` } : { status: 'idle' },
  );
  const [check, setCheck] = useState<Stage>(
    signedIn ? { status: 'ok', detail: 'Reading your calendars and writing tracked time back.' } : { status: 'idle' },
  );
  const cancelled = useRef(false);
  const [busy, setBusy] = useState(false);

  /*
   * The calendar settings as last saved, kept outside React's render cycle.
   * A sign-in saves several times in one async run (the grant, then the
   * address, then the log calendar), and the `settings` prop of the render
   * that started the run still holds the empty grant, so merging into it would
   * wipe the token that had just been saved.
   */
  const latest = useRef(settings.calendar);
  latest.current = settings.calendar;
  const saveGoogle = (patch: Partial<Settings['calendar']['google']>): void => {
    const calendar = { ...latest.current, google: { ...latest.current.google, ...patch } };
    latest.current = calendar;
    onSave({ calendar });
  };

  /** Proves the grant works: lists the week and finds or makes the log calendar. */
  const prove = async (access: Settings['calendar']['google']): Promise<void> => {
    setCheck({ status: 'running', detail: 'Reading your calendars.' });
    const cal = new GoogleCalendarClient(http, {
      client: { clientId: client?.clientId ?? '', ...(client?.clientSecret === undefined ? {} : { clientSecret: client.clientSecret }) },
      tokens: { accessToken: access.accessToken, refreshToken: access.refreshToken, expiresAt: access.expiresAt },
      onTokens: tokens => saveGoogle(tokens),
      onLogCalendar: id => saveGoogle({ logCalendarId: id }),
    });
    try {
      const events = await cal.listEvents({ from: Date.now(), days: 7 });
      const email = await cal.email().catch(() => '');
      const logId = await cal.logCalendarId();
      saveGoogle({ email, logCalendarId: logId });
      setSignIn({ status: 'ok', detail: `Signed in as ${email || 'your Google account'}.` });
      const scope = cal.calendarsRead > 1 ? `Reading ${cal.calendarsRead} calendars` : 'Reading your calendar';
      setCheck({
        status: 'ok',
        detail:
          events.length === 0
            ? `${scope}. Nothing scheduled in the next seven days. Tracked time is written to "to-hoot log".`
            : `${scope}. ${events.length} events in the next seven days. Tracked time is written to "to-hoot log".`,
      });
    } catch (err) {
      setCheck({ status: 'error', detail: err instanceof Error ? err.message : String(err) });
    }
  };

  const start = async (): Promise<void> => {
    if (client === null || listener === null) return;
    cancelled.current = false;
    setBusy(true);
    setCheck({ status: 'idle' });
    try {
      const attempt = await newOAuthAttempt();
      const url = googleAuthUrl(client, listener.redirectUri, attempt);
      setSignIn({ status: 'running', detail: 'Approve ToHoot in the browser that just opened.' });
      if (openUrl !== undefined) void openUrl(url);
      else globalThis.window?.open(url, '_blank', 'noopener,noreferrer');
      let callback: string;
      try {
        callback = await listener.waitForCallback(() => cancelled.current);
      } catch (err) {
        setSignIn(cancelled.current ? { status: 'idle' } : { status: 'error', detail: err instanceof Error ? err.message : String(err) });
        return;
      }
      const code = readCallback(callback, attempt);
      if (code.status === 'error') {
        setSignIn({ status: 'error', detail: code.detail, hint: code.hint });
        return;
      }
      setSignIn({ status: 'running', detail: 'Finishing the sign-in.' });
      const grant = await exchangeGoogleCode(http, client, listener.redirectUri, code.value, attempt);
      if (grant.status === 'error') {
        setSignIn({ status: 'error', detail: grant.detail, hint: grant.hint });
        return;
      }
      const access = { ...EMPTY_GOOGLE_ACCESS, ...grant.value };
      saveGoogle(access);
      setSignIn({ status: 'ok', detail: 'Signed in with Google.' });
      await prove(access);
    } finally {
      setBusy(false);
    }
  };

  const cancel = (): void => {
    cancelled.current = true;
  };

  const signOut = async (): Promise<void> => {
    const token = google.refreshToken;
    saveGoogle({ ...EMPTY_GOOGLE_ACCESS });
    setSignIn({ status: 'idle' });
    setCheck({ status: 'idle' });
    await revokeGoogleGrant(http, token);
  };

  return (
    <div className="step">
      <h2>Your calendar</h2>
      <p className="prose step-lead">
        Sign in once and your day appears beside your tasks, with tracked time written back to a
        separate calendar of its own. Your real calendars are read and never changed.
      </p>

      <Flow label="Connecting Google Calendar">
        <FlowStep
          status={signIn.status}
          title={signedIn ? `Signed in as ${google.email || 'your Google account'}` : 'Sign in with Google'}
          detail={signedIn && signIn.status === 'ok' ? undefined : signIn.detail}
          hint={signIn.hint}
        >
          {signedIn ? (
            <div className="step-actions">
              <button type="button" className="button" onClick={() => void signOut()}>
                Sign out
              </button>
            </div>
          ) : signIn.status === 'running' ? (
            <div className="step-actions">
              <button type="button" className="button" onClick={cancel}>
                Cancel
              </button>
              <p className="field-hint">
                Google may say the app is unverified. It is yours: press Advanced, then continue to
                ToHoot.
              </p>
            </div>
          ) : (
            <>
              <div className="step-actions">
                <button
                  type="button"
                  className="button button-primary"
                  disabled={busy || !canSignIn}
                  onClick={() => void start()}
                >
                  Sign in with Google
                </button>
              </div>
              {canSignIn ? null : (
                <p className="field-hint">
                  Sign-in needs the desktop or the Android app: a browser tab has nowhere for Google
                  to send the answer back to. The two routes below work anywhere.
                </p>
              )}
            </>
          )}
        </FlowStep>

        <FlowStep
          status={check.status}
          title={check.status === 'ok' ? 'Connected' : 'Check the calendar'}
          detail={check.detail}
          hint={check.hint}
        >
          {signedIn && check.status !== 'running' ? (
            <div className="step-actions">
              <button type="button" className="button" onClick={() => void prove(google)}>
                {check.status === 'error' ? 'Try again' : 'Check again'}
              </button>
            </div>
          ) : null}
        </FlowStep>
      </Flow>

      <hr className="step-rule" />

      <Reveal label="Only show my events, without signing in">
        <IcsRoute http={http} settings={settings} onSave={onSave} openUrl={openUrl} field={field} />
      </Reveal>

      <Reveal label="Use an Apps Script bridge instead">
        <BridgeRoute http={http} settings={settings} onSave={onSave} openUrl={openUrl} field={field} />
      </Reveal>
    </div>
  );
}

interface RouteProps {
  http: Http;
  settings: Settings;
  onSave: (patch: Partial<Settings>) => void;
  openUrl?: ((url: string) => Promise<void>) | undefined;
  field: (name: string) => string;
}

/** A secret iCal address: read-only, no sign-in, works in any shell. */
function IcsRoute({ http, settings, onSave, openUrl, field }: RouteProps) {
  const [icsUrl, setIcsUrl] = useState(settings.calendar.icsUrl);
  const [icsState, runIcs] = useCheck();
  return (
    <>
      <p className="prose">
        A secret iCal address needs no sign-in. It is read-only: your day appears on the timeline,
        but tracked time is not written back.
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
    </>
  );
}

/*
 * The Apps Script bridge, as it was before sign-in existed. Kept for a
 * deployment that is already running, and for anyone who would rather not
 * grant the app a Google token. The secret is NOT substituted into the script
 * source: the deployed script only ever reads it from a Script Property.
 */
function BridgeRoute({ http, settings, onSave, openUrl, field }: RouteProps) {
  const [secret, setSecret] = useState(() => settings.calendar.secret || generateSecret());
  const [execUrl, setExecUrl] = useState(settings.calendar.execUrl);
  const [bridgeState, runBridge] = useCheck();

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
          <strong>Deploy, New deployment, Web app</strong>, running as you, with access set to anyone
          with the link. Paste the <span className="mono">/exec</span> URL it gives you and the check
          runs by itself.
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
  );
}
