import { useId, useState } from 'react';
import type { Http, Settings } from '@to-hoot/core';

import { CheckResult, SecretField, TestConnection, TextField, useCheck } from '../fields.js';
import {
  checkDeviceId,
  createDataRepo,
  readRepo,
  testSync,
  verifyToken,
  type GitHubAccount,
  type RepoTarget,
} from '../../setup.js';

export interface StepSyncProps {
  http: Http;
  settings: Settings;
  onSave: (patch: Partial<Settings>) => void;
}

/*
 * Sync.
 *
 * Three things have to be true before this can be called done, and each is
 * checked by doing it rather than by looking at it: the token belongs to
 * somebody, the repository exists and is private, and a commit written to it
 * comes back byte for byte.
 *
 * The branch is read from the API and stored. It is never assumed to be `main`:
 * a repository created through `gh repo create`, or under an account whose
 * default was never changed, comes out as `master`, and every read and write
 * would then be aimed at a branch that is not there.
 */
export function StepSync({ http, settings, onSave }: StepSyncProps) {
  const ids = useId();
  const field = (name: string): string => `${ids}-${name}`;

  const [token, setToken] = useState(settings.github.token);
  const [account, setAccount] = useState<GitHubAccount | null>(null);
  const [repoName, setRepoName] = useState(settings.github.repo || 'to-hoot-data');
  /*
   * Seeded from what was stored, never from a literal.
   *
   * This used to re-seed `branch: 'main'` on every remount. On a repository
   * whose default is `master` that produced a green connection test against a
   * branch that did not exist: the ref read 404s, which the client reads as "no
   * commits yet", so the commit went in parentless and created an orphan
   * `refs/heads/main` beside the user's real data.
   */
  const [target, setTarget] = useState<RepoTarget | null>(
    settings.github.owner === ''
      ? null
      : {
          owner: settings.github.owner,
          repo: settings.github.repo,
          branch: settings.github.branch,
        },
  );
  const [device, setDevice] = useState(settings.deviceId);

  const [tokenState, runToken] = useCheck();
  const [repoState, runRepo] = useCheck();
  const [syncState, runSync] = useCheck();

  const deviceCheck = device.trim() === '' ? null : checkDeviceId(device);

  const save = (patch: Partial<RepoTarget>): void => {
    const merged = { ...(target ?? { owner: '', repo: '', branch: '' }), ...patch };
    setTarget(merged);
    // The branch is part of what is saved. Reading it and then dropping it was
    // the whole bug: nothing downstream could tell master from main.
    onSave({
      github: {
        owner: merged.owner,
        repo: merged.repo,
        branch: merged.branch,
        token: token.trim(),
      },
    });
  };

  return (
    <div className="step">
      <h2>Sync between devices</h2>
      <p className="prose step-lead">
        Your tasks live in a private GitHub repository that you own and can delete. to-hoot
        never sees it; the token stays on this device.
      </p>

      <SecretField
        id={field('token')}
        label="GitHub token"
        value={token}
        onChange={setToken}
        placeholder="github_pat_..."
        hint={
          <>
            A fine-grained personal access token with <strong>Contents: read and write</strong> on
            the data repository alone. To let the button below create the repository for you, it
            also needs <strong>Administration: write</strong>.
          </>
        }
      />

      <TestConnection
        label="Verify token"
        state={tokenState}
        disabled={token.trim() === ''}
        onTest={() =>
          runToken(async () => {
            const check = await verifyToken(http, token);
            setAccount(check.status === 'ok' ? check.value : null);
            return check;
          })
        }
      />

      {account === null ? null : (
        <>
          <hr className="step-rule" />
          <h3 className="micro">Data repository</h3>

          <TextField
            id={field('repo')}
            label="Repository name"
            value={repoName}
            onChange={setRepoName}
            hint={`Will be created as ${account.login}/${repoName || 'to-hoot-data'}, private.`}
          />

          {/* Two routes to one outcome, so they share a result line. A result
              beside each button said the same thing twice. */}
          <div className="step-actions">
            <button
              type="button"
              className="button"
              disabled={repoState.phase === 'running'}
              onClick={() =>
                void runRepo(async () => {
                  const check = await createDataRepo(http, token, repoName);
                  if (check.status === 'ok') save(check.value);
                  return check;
                })
              }
            >
              Create it for me
            </button>
            <button
              type="button"
              className="button"
              disabled={repoState.phase === 'running'}
              onClick={() =>
                void runRepo(async () => {
                  // Reads the repository's own default_branch, which is the
                  // whole reason this is a request rather than an assumption.
                  const check = await readRepo(http, token, account.login, repoName);
                  if (check.status === 'ok') save(check.value);
                  return check;
                })
              }
            >
              Use an existing one
            </button>
          </div>
          <CheckResult state={repoState} />
        </>
      )}

      {target === null ? null : (
        <>
          <hr className="step-rule" />
          <h3 className="micro">This device</h3>

          <TextField
            id={field('device')}
            label="Device name"
            value={device}
            onChange={setDevice}
            placeholder="laptop"
            invalid={deviceCheck?.status === 'error'}
            hint={
              deviceCheck === null
                ? 'Each device writes its own events under this name.'
                : deviceCheck.status === 'ok'
                  ? deviceCheck.detail
                  : `${deviceCheck.detail} ${deviceCheck.hint ?? ''}`
            }
          />

          <TestConnection
            label="Test sync"
            state={syncState}
            disabled={deviceCheck?.status !== 'ok'}
            onTest={() =>
              runSync(async () => {
                const check = await testSync(http, token, target);
                if (check.status === 'ok') {
                  onSave({
                    github: {
                      owner: check.value.owner,
                      repo: check.value.repo,
                      branch: check.value.branch,
                      token: token.trim(),
                    },
                    deviceId: device.trim(),
                    deviceName: device.trim(),
                  });
                }
                return check;
              })
            }
          />
          <p className="field-hint">
            Writes a commit to {target.owner}/{target.repo} on{' '}
            {target.branch === '' ? 'its default branch' : target.branch} and reads it back.
          </p>
        </>
      )}
    </div>
  );
}
