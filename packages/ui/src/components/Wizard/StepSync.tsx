import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { Http, PlatformKind, Settings } from '@to-hoot/core';

import {
  CopyButton,
  ExternalLink,
  Flow,
  FlowStep,
  Reveal,
  SecretField,
  TextField,
  type FlowStatus,
} from '../fields.js';
import {
  DEFAULT_REPO_NAME,
  GITHUB_NEW_TOKEN,
  checkDeviceId,
  checkDeviceName,
  joinOrCreateRepo,
  startDeviceLogin,
  suggestDeviceName,
  testSync,
  verifyToken,
  waitForDeviceLogin,
  type DeviceCode,
  type GitHubAccount,
  type JoinedRepo,
} from '../../setup.js';

export interface StepSyncProps {
  http: Http;
  settings: Settings;
  onSave: (patch: Partial<Settings>) => void;
  /** What the shell says it is, which is what names this device. */
  deviceKind?: PlatformKind | undefined;
  /** The shell's way of opening a link, where the host will not follow one. */
  openUrl?: ((url: string) => Promise<void>) | undefined;
}

/*
 * Sync, as a flow that runs itself.
 *
 * The person presses one button. Everything after it is the app doing what a
 * person used to do by hand: sign in through GitHub's device flow, look for the
 * data repository and make it when it is not there, name this device after
 * what it is, and prove the round trip works. Each of those is a line on the
 * screen that fills in as it happens, and a button appears only where the
 * decision is genuinely theirs: which of two phones this is, or a different
 * repository name.
 *
 * The token path is still here, folded away. A fine-grained token is the
 * narrower credential and some people will want it; once a token exists by
 * either route the rest of the flow is identical.
 *
 * Nothing about the repository itself changes. The branch is still read from
 * the API and never assumed, the repository is still inspected before it is
 * written to, and a device still writes only under its own name.
 */
export function StepSync({ http, settings, onSave, deviceKind, openUrl }: StepSyncProps) {
  const ids = useId();
  const field = (name: string): string => `${ids}-${name}`;

  const already = settings.github.token !== '' && settings.github.owner !== '';

  // The token in hand, from sign-in, from the token field, or from settings.
  const [token, setToken] = useState<string>(already ? settings.github.token : '');
  const [account, setAccount] = useState<GitHubAccount | null>(
    already ? { login: settings.github.owner } : null,
  );
  const [accountState, setAccountState] = useState<{ status: FlowStatus; detail?: string; hint?: string }>(
    already ? { status: 'ok', detail: `Signed in as ${settings.github.owner}.` } : { status: 'idle' },
  );

  // Sign-in, in progress.
  const [code, setCode] = useState<DeviceCode | null>(null);
  const cancelled = useRef(false);

  // The token path, folded away.
  const [typed, setTyped] = useState('');

  // The repository.
  const [repoName, setRepoName] = useState(settings.github.repo || DEFAULT_REPO_NAME);
  const [joined, setJoined] = useState<JoinedRepo | null>(null);
  const [repoState, setRepoState] = useState<{ status: FlowStatus; detail?: string; hint?: string }>(
    already
      ? { status: 'ok', detail: `${settings.github.owner}/${settings.github.repo}.` }
      : { status: 'idle' },
  );

  // This device.
  const [device, setDevice] = useState(settings.deviceId);
  const [draft, setDraft] = useState(settings.deviceId);
  /** Set once the person has answered whether a taken name is this device. */
  const [replacing, setReplacing] = useState<boolean | null>(null);

  // The round trip.
  const [syncState, setSyncState] = useState<{ status: FlowStatus; detail?: string; hint?: string }>(
    already ? { status: 'ok', detail: 'Connected. Tasks from every device appear here.' } : { status: 'idle' },
  );
  /** The key the last round trip ran for, so the same settings are not tested twice. */
  const tested = useRef<string | null>(null);
  /**
   * A device that opens this screen already connected is not re-tested on
   * arrival: the sync controller is already proving that every minute, and a
   * commit for the sake of a screen is a commit nobody asked for. The first key
   * is recorded as tested; a rename or Check again is a new key.
   */
  const skipFirst = useRef(already && settings.deviceId !== '');
  /** Bumped by Try again, so the key changes even when nothing else did. */
  const [attempt, setAttempt] = useState(0);

  const taken = joined?.contents.deviceIds ?? [];
  const trimmed = device.trim();
  const shape = trimmed === '' ? null : checkDeviceName(trimmed, replacing === true ? [] : taken);
  /**
   * The name as it is being typed, checked for shape only. A clash is answered
   * after the rename is committed, with the two-button question; a name that
   * cannot be a folder is refused while it is still in the field.
   */
  const draftShape = draft.trim() === '' ? null : checkDeviceId(draft.trim());
  /** True while a taken name is on the field and nobody has said whose it is. */
  const clash = trimmed !== '' && taken.includes(trimmed) && replacing === null && settings.deviceId !== trimmed;

  /** Everything after the token, in order. */
  const connect = useCallback(
    async (tok: string, name: string): Promise<void> => {
      setJoined(null);
      setSyncState({ status: 'idle' });
      tested.current = null;

      setAccountState({ status: 'running', detail: 'Checking the token.' });
      const who = await verifyToken(http, tok);
      if (who.status === 'error') {
        setAccountState({ status: 'error', detail: who.detail, hint: who.hint });
        return;
      }
      setToken(tok.trim());
      setAccount(who.value);
      setAccountState({ status: 'ok', detail: who.detail });

      setRepoState({ status: 'running', detail: `Looking for ${who.value.login}/${name}.` });
      const repo = await joinOrCreateRepo(http, tok.trim(), who.value.login, name);
      if (repo.status === 'error') {
        setRepoState({ status: 'error', detail: repo.detail, hint: repo.hint });
        return;
      }
      setJoined(repo.value);
      setRepoState({ status: 'ok', detail: repo.detail });
      // The repository is settled and can be saved now, so a person who stops
      // here still has the right target next time. The token travels with it.
      onSave({
        github: {
          owner: repo.value.target.owner,
          repo: repo.value.target.repo,
          branch: repo.value.target.branch,
          token: tok.trim(),
        },
      });

      // A device that already has a name keeps it, whatever the repository
      // says: the name in the repository is this device's own earlier writes.
      const suggested =
        settings.deviceId !== '' ? settings.deviceId : suggestDeviceName(deviceKind, repo.value.contents.deviceIds);
      setDevice(suggested);
      setDraft(suggested);
      setReplacing(null);
    },
    [http, onSave, settings.deviceId, deviceKind],
  );

  const signIn = async (): Promise<void> => {
    cancelled.current = false;
    setAccountState({ status: 'running', detail: 'Asking GitHub for a code.' });
    const started = await startDeviceLogin(http);
    if (started.status === 'error') {
      setAccountState({ status: 'error', detail: started.detail, hint: started.hint });
      return;
    }
    setCode(started.value);
    // Copied before the browser opens, so the code is already on the clipboard
    // when GitHub asks for it. A failure here is silent: the code is on screen.
    void navigator.clipboard?.writeText(started.value.userCode).catch(() => undefined);
    setAccountState({ status: 'running', detail: 'Waiting for you to approve it on GitHub.' });
    const got = await waitForDeviceLogin(http, started.value, { cancelled: () => cancelled.current });
    setCode(null);
    if (got.status === 'error') {
      setAccountState(
        cancelled.current ? { status: 'idle' } : { status: 'error', detail: got.detail, hint: got.hint },
      );
      return;
    }
    await connect(got.value, repoName);
  };

  const cancelSignIn = (): void => {
    cancelled.current = true;
    setCode(null);
    setAccountState({ status: 'idle' });
  };

  const signOut = (): void => {
    setToken('');
    setAccount(null);
    setJoined(null);
    setAccountState({ status: 'idle' });
    setRepoState({ status: 'idle' });
    setSyncState({ status: 'idle' });
    tested.current = null;
    onSave({ github: { owner: '', repo: '', branch: '', token: '' } });
  };

  /*
   * The round trip runs itself once everything it needs is settled: a token, a
   * repository, and a device name nobody else is using or that this person has
   * claimed. Keyed on those, so renaming the device runs it again and nothing
   * else does.
   */
  const fromSettings = useMemo(
    () =>
      already
        ? { owner: settings.github.owner, repo: settings.github.repo, branch: settings.github.branch }
        : undefined,
    [already, settings.github.owner, settings.github.repo, settings.github.branch],
  );
  const target = joined?.target ?? fromSettings;
  const ready = token !== '' && target !== undefined && shape?.status === 'ok' && !clash;
  const key = ready ? `${target.owner}/${target.repo}@${target.branch}:${trimmed}#${attempt}` : null;
  useEffect(() => {
    if (key === null || target === undefined) return;
    if (skipFirst.current) {
      skipFirst.current = false;
      tested.current = key;
      return;
    }
    if (tested.current === key) return;
    tested.current = key;
    setSyncState({
      status: 'running',
      detail: `Writing a commit to ${target.owner}/${target.repo} and reading it back.`,
    });
    void testSync(http, token, target).then(check => {
      // A later key means the person changed something while this ran, and
      // the newer run owns the screen.
      if (tested.current !== key) return;
      if (check.status === 'error') {
        setSyncState({ status: 'error', detail: check.detail, hint: check.hint });
        return;
      }
      onSave({
        github: { owner: check.value.owner, repo: check.value.repo, branch: check.value.branch, token },
        deviceId: trimmed,
        deviceName: trimmed,
      });
      setSyncState({ status: 'ok', detail: 'Connected. Tasks from every device appear here.' });
    });
    // Only the key: everything the run reads is what the key was built from.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const retry = (): void => {
    setSyncState({ status: 'idle' });
    setAttempt(a => a + 1);
  };

  const commitDraft = (): void => {
    setDevice(draft);
    setReplacing(null);
  };

  return (
    <div className="step">
      <h2>Sync between devices</h2>
      <p className="prose step-lead">
        Your tasks live in a private GitHub repository you own. Every device writes its own folder
        there and reads everyone else's, so the laptop sees the phone's tasks and the phone sees the
        laptop's. ToHoot never sees any of it.
      </p>

      <Flow label="Connecting to GitHub">
        <FlowStep
          status={accountState.status}
          title={account === null ? 'Your GitHub account' : `Signed in as ${account.login}`}
          detail={account === null ? accountState.detail : undefined}
          hint={accountState.hint}
        >
          {account !== null ? (
            <div className="step-actions">
              <button type="button" className="button" onClick={signOut}>
                Sign out
              </button>
            </div>
          ) : code !== null ? (
            <div className="device-code" role="group" aria-label="GitHub device code">
              <span className="micro">Enter this code on GitHub</span>
              <span className="device-code-value mono" data-user-code="">
                {code.userCode}
              </span>
              <div className="step-actions">
                <CopyButton text={code.userCode} label="Copy the code" />
                <ExternalLink href={code.verificationUri} openUrl={openUrl}>
                  Open GitHub
                </ExternalLink>
                <button type="button" className="button" onClick={cancelSignIn}>
                  Cancel
                </button>
              </div>
              <p className="field-hint">
                The code is on your clipboard. Approve ToHoot on the page that opens and this screen
                carries on by itself.
              </p>
            </div>
          ) : (
            <>
              <div className="step-actions">
                <button
                  type="button"
                  className="button button-primary"
                  disabled={accountState.status === 'running'}
                  onClick={() => void signIn()}
                >
                  Sign in with GitHub
                </button>
              </div>
              <Reveal label="Use a token instead">
                <SecretField
                  id={field('token')}
                  label="GitHub token"
                  value={typed}
                  onChange={setTyped}
                  placeholder="github_pat_..."
                  hint={
                    <>
                      A fine-grained token with <strong>Contents: read and write</strong> on the data
                      repository. To let this screen create the repository for you, it also needs{' '}
                      <strong>Administration: write</strong>.
                    </>
                  }
                />
                <div className="step-actions">
                  <button
                    type="button"
                    className="button"
                    disabled={typed.trim() === '' || accountState.status === 'running'}
                    onClick={() => void connect(typed, repoName)}
                  >
                    Verify token
                  </button>
                  <ExternalLink href={GITHUB_NEW_TOKEN} openUrl={openUrl}>
                    Create a token on GitHub
                  </ExternalLink>
                </div>
              </Reveal>
            </>
          )}
        </FlowStep>

        <FlowStep
          status={repoState.status}
          title={
            joined === null && !already
              ? 'Find or create the data repository'
              : `Repository: ${target?.owner ?? settings.github.owner}/${target?.repo ?? settings.github.repo}`
          }
          detail={repoState.detail}
          hint={repoState.hint}
        >
          {account === null ? null : (
            <Reveal label="Use another repository">
              <TextField
                id={field('repo')}
                label="Repository name"
                value={repoName}
                onChange={setRepoName}
                hint={`${account.login}/${repoName || DEFAULT_REPO_NAME}, private. Created if it does not exist.`}
              />
              <div className="step-actions">
                <button
                  type="button"
                  className="button"
                  disabled={repoName.trim() === '' || repoState.status === 'running'}
                  onClick={() => void connect(token, repoName.trim())}
                >
                  Use this repository
                </button>
              </div>
            </Reveal>
          )}
        </FlowStep>

        <FlowStep
          status={
            trimmed === ''
              ? 'idle'
              : clash
                ? 'error'
                : shape?.status === 'error'
                  ? 'error'
                  : joined !== null || already
                    ? 'ok'
                    : 'idle'
          }
          title={trimmed === '' ? 'Name this device' : `This device: ${trimmed}`}
          detail={
            clash
              ? `Another device is already called "${trimmed}".`
              : shape?.status === 'error'
                ? shape.detail
                : trimmed === ''
                  ? undefined
                  : `Events are written under events/${trimmed}/.`
          }
          hint={!clash && shape?.status === 'error' ? shape.hint : undefined}
        >
          {joined === null && !already ? null : (
            <>
              {clash ? (
                <div className="step-actions" role="group" aria-label="Whose device is this">
                  <span className="field-hint">Is that this {deviceKind === 'android' ? 'phone' : 'device'}, set up again?</span>
                  <button type="button" className="button" onClick={() => setReplacing(true)}>
                    Yes, this is it
                  </button>
                  <button
                    type="button"
                    className="button"
                    onClick={() => {
                      const next = suggestDeviceName(deviceKind, taken);
                      setDevice(next);
                      setDraft(next);
                      setReplacing(false);
                    }}
                  >
                    No, it is another one
                  </button>
                </div>
              ) : null}
              <form
                className="field-row"
                onSubmit={e => {
                  e.preventDefault();
                  if (draftShape?.status === 'ok') commitDraft();
                }}
              >
                <TextField
                  id={field('device')}
                  label="Device name"
                  value={draft}
                  onChange={setDraft}
                  placeholder={suggestDeviceName(deviceKind, [])}
                  invalid={draftShape?.status === 'error'}
                  hint={
                    draftShape?.status === 'error'
                      ? `${draftShape.detail} ${draftShape.hint ?? ''}`
                      : 'Two devices must never share a name: each writes only its own folder.'
                  }
                />
                {draft.trim() !== trimmed ? (
                  <button
                    type="submit"
                    className="button field-button-tall"
                    disabled={draftShape?.status !== 'ok'}
                  >
                    Rename this device
                  </button>
                ) : null}
              </form>
            </>
          )}
        </FlowStep>

        <FlowStep
          status={syncState.status}
          title={syncState.status === 'ok' ? 'Connected' : 'Check the connection'}
          detail={syncState.detail}
          hint={syncState.hint}
        >
          {syncState.status === 'error' || (already && syncState.status === 'ok') ? (
            <div className="step-actions">
              <button type="button" className="button" onClick={retry}>
                {syncState.status === 'error' ? 'Try again' : 'Check again'}
              </button>
            </div>
          ) : null}
        </FlowStep>
      </Flow>
    </div>
  );
}
