import { useEffect, useId, useRef, useState } from 'react';
import type { ClaudeCodeServer, Http, Platform, Settings } from '@to-hoot/core';

import {
  Copyable,
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
  CLAUDE_CONNECTORS,
  CLOUDFLARE_DASHBOARD,
  CLOUDFLARE_TOKEN_URL,
  SETUP_GUIDE,
  cloudflareAuthUrl,
  deployWorker,
  endpointUrl,
  exchangeCloudflareCode,
  fetchWorkerBundle,
  generateSecret,
  listCloudflareAccounts,
  mcpAddCommand,
  newOAuthAttempt,
  readCallback,
  revokeCloudflareToken,
  testWorker,
  wranglerCommands,
  type CloudflareAccount,
} from '../../setup.js';

export interface StepClaudeProps {
  http: Http;
  settings: Settings;
  onSave: (patch: Partial<Settings>) => void;
  mcpServerPath?: string;
  /** The shell's way of opening a link, where the host will not follow one. */
  openUrl?: ((url: string) => Promise<void>) | undefined;
  /** The shell, for whether a sign-in can come back to it, and Claude Code's config. */
  platform?: Pick<Platform, 'kind' | 'oauthLoopback' | 'claudeCode'> | undefined;
}

/** The name the server has in Claude Code, which is also what `claude mcp add` was told. */
export const CLAUDE_CODE_SERVER = 'to-hoot';

const DEFAULT_MCP_PATH = 'apps/mcp/dist/index.js';

type Stage = { status: FlowStatus; detail?: string; hint?: string };

/*
 * Claude.
 *
 * Two independent paths, both optional. Claude Code talks to a local process
 * over stdio and needs nothing but a command pasted once. Claude on the web and
 * on a phone cannot reach a local process, so they need an endpoint, and the
 * endpoint deploys from this screen with one press.
 *
 * That press signs in with Cloudflare in the browser, using the same public
 * OAuth client wrangler uses, and then makes the same upload wrangler makes:
 * the app downloads the Worker built for this release, uploads it with the
 * four secrets as bindings, switches on its workers.dev route, and asks the
 * new endpoint for its tools. Every stage is a line that fills in. The token
 * lives in memory for the deploy and is revoked the moment it is done; it can
 * rewrite every Worker on the account, and a task app has no business keeping
 * that.
 *
 * Cloudflare's client only redirects to localhost, so the sign-in needs the
 * desktop app. The phone learns the endpoint exists through sync and shows it
 * as deployed. A pasted API token and wrangler stay available, folded away.
 */
export function StepClaude({ http, settings, onSave, mcpServerPath, openUrl, platform }: StepClaudeProps) {
  const ids = useId();
  const field = (name: string): string => `${ids}-${name}`;

  /*
   * Generated once and stored, not on every mount. Regenerating it here meant
   * reopening this step showed a different secret from the endpoint URL sitting
   * beside it, so following the commands quietly broke the endpoint that was
   * already saved.
   */
  const [pathSecret, setPathSecret] = useState(() => settings.worker.pathSecret || generateSecret());
  useEffect(() => {
    if (settings.worker.pathSecret === '') {
      onSave({ worker: { ...settings.worker, pathSecret } });
    }
  }, [settings.worker, pathSecret, onSave]);

  const rotatePath = (): void => {
    const next = generateSecret();
    setPathSecret(next);
    onSave({ worker: { ...settings.worker, pathSecret: next } });
  };

  const githubReady =
    settings.github.owner !== '' && settings.github.repo !== '' && settings.github.token !== '';

  const listener = platform?.oauthLoopback?.() ?? null;
  const canSignIn = listener !== null;
  const deployedElsewhere = settings.worker.url === '' && settings.worker.base !== '';
  /*
   * A phone neither runs Claude Code nor deploys: Cloudflare's sign-in comes
   * back to a desktop only. What it can do is know whether the desktop has
   * deployed, which the hostname in the log tells it, and hand the person to
   * Claude. So it gets that and none of the controls it cannot press.
   */
  const phone = platform?.kind === 'android';

  /*
   * Claude Code. The app writes the server into Claude Code's own config,
   * which is what the terminal command does. With an endpoint deployed it
   * points Claude Code at that, so an installed app needs no checkout and no
   * build; without one it points at the local stdio server.
   */
  const claudeCode = platform?.claudeCode;
  const [codeState, setCodeState] = useState<Stage>({ status: 'idle' });
  const [codeTarget, setCodeTarget] = useState<string | null>(null);
  useEffect(() => {
    if (claudeCode === undefined) return;
    let live = true;
    claudeCode
      .inspect(CLAUDE_CODE_SERVER)
      .then(entry => {
        if (!live) return;
        setCodeTarget(entry.present ? entry.target : null);
        setCodeState(entry.present ? { status: 'ok', detail: `Registered in ${entry.path}.` } : { status: 'idle' });
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [claudeCode]);

  const serverForClaudeCode = (): ClaudeCodeServer =>
    settings.worker.url === ''
      ? { type: 'stdio', command: 'node', args: [mcpServerPath ?? DEFAULT_MCP_PATH] }
      : { type: 'http', url: settings.worker.url };

  const addToClaudeCode = async (): Promise<void> => {
    if (claudeCode === undefined) return;
    const server = serverForClaudeCode();
    setCodeState({ status: 'running', detail: 'Writing it into Claude Code.' });
    try {
      const path = await claudeCode.add(CLAUDE_CODE_SERVER, server);
      setCodeTarget(server.type === 'http' ? server.url : server.command);
      setCodeState({
        status: 'ok',
        detail: `Registered in ${path}. Claude Code picks it up the next time it starts.`,
      });
    } catch (err) {
      setCodeState({ status: 'error', detail: err instanceof Error ? err.message : String(err) });
    }
  };
  // The entry is stale when the endpoint changed under it: a redeploy with a
  // new path secret, or a first deploy after a stdio registration.
  const wanted = serverForClaudeCode();
  const wantedTarget = wanted.type === 'http' ? wanted.url : wanted.command;
  const codeStale = codeState.status === 'ok' && codeTarget !== null && codeTarget !== wantedTarget;

  // The deploy, stage by stage.
  const [apiToken, setApiToken] = useState('');
  const [accounts, setAccounts] = useState<CloudflareAccount[] | null>(null);
  const [accountId, setAccountId] = useState('');
  const [signIn, setSignIn] = useState<Stage>(settings.worker.url === '' ? { status: 'idle' } : { status: 'ok' });
  const [deploy, setDeploy] = useState<Stage>(
    settings.worker.url === ''
      ? deployedElsewhere
        ? { status: 'ok', detail: `Deployed from another device at ${settings.worker.base}.` }
        : { status: 'idle' }
      : { status: 'ok', detail: `Endpoint: ${settings.worker.url}` },
  );
  const [busy, setBusy] = useState(false);
  const cancelled = useRef(false);
  /** A token from the sign-in, held only until the deploy that uses it is done. */
  const grant = useRef('');

  /** Signs in with Cloudflare in the browser and deploys with what comes back. */
  const signInAndDeploy = async (): Promise<void> => {
    if (listener === null) return;
    cancelled.current = false;
    setBusy(true);
    try {
      const attempt = await newOAuthAttempt();
      setSignIn({ status: 'running', detail: 'Approve ToHoot in the browser that just opened.' });
      const url = cloudflareAuthUrl(attempt);
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
      const token = await exchangeCloudflareCode(http, code.value, attempt);
      if (token.status === 'error') {
        setSignIn({ status: 'error', detail: token.detail, hint: token.hint });
        return;
      }
      grant.current = token.value;
      setSignIn({ status: 'ok', detail: 'Signed in with Cloudflare.' });
      await runDeploy(token.value);
    } finally {
      setBusy(false);
    }
  };

  const cancelSignIn = (): void => {
    cancelled.current = true;
  };

  const runDeploy = async (token: string): Promise<void> => {
    setBusy(true);
    let keepToken = false;
    try {
      setDeploy({ status: 'running', detail: 'Checking the Cloudflare account.' });
      const found = await listCloudflareAccounts(http, token);
      if (found.status === 'error') {
        setDeploy({ status: 'error', detail: found.detail, hint: found.hint });
        return;
      }
      setAccounts(found.value);
      const chosen = found.value.length === 1 ? found.value[0]!.id : accountId;
      if (chosen === '') {
        // The person has to pick one; the token waits for that press only.
        keepToken = true;
        setDeploy({ status: 'idle', detail: 'This account can deploy to more than one Cloudflare account. Choose one.' });
        return;
      }

      setDeploy({ status: 'running', detail: 'Downloading the Worker for this version.' });
      const bundle = await fetchWorkerBundle(http);
      if (bundle.status === 'error') {
        setDeploy({ status: 'error', detail: bundle.detail, hint: bundle.hint });
        return;
      }

      setDeploy({ status: 'running', detail: 'Uploading it and switching the endpoint on.' });
      const result = await deployWorker(http, {
        apiToken: token,
        accountId: chosen,
        bundle: bundle.value,
        pathSecret,
        secrets: {
          MCP_PATH_SECRET: pathSecret,
          GITHUB_OWNER: settings.github.owner,
          GITHUB_REPO: settings.github.repo,
          GITHUB_TOKEN: settings.github.token,
          GITHUB_BRANCH: settings.github.branch,
        },
      });
      if (result.status === 'error') {
        setDeploy({ status: 'error', detail: result.detail, hint: result.hint });
        return;
      }
      onSave({ worker: { url: result.value.endpoint, pathSecret, base: result.value.base } });
      setDeploy({ status: 'ok', detail: result.detail });
    } finally {
      // Forgotten on purpose, whatever happened, and a signed-in token is
      // revoked as well so nothing on Cloudflare's side outlives the deploy.
      if (!keepToken) {
        setApiToken('');
        if (grant.current !== '') {
          const revoke = grant.current;
          grant.current = '';
          void revokeCloudflareToken(http, revoke);
        }
      }
      setBusy(false);
    }
  };

  /** After an account was chosen, deploys with whichever token is still held. */
  const deployWithChosen = (): void => {
    void runDeploy(grant.current !== '' ? grant.current : apiToken);
  };

  const endpoint = settings.worker.url;

  // The wrangler path, unchanged in substance and folded away.
  const [workerUrl, setWorkerUrl] = useState(settings.worker.url);
  const [manualState, runManual] = useCheck();
  const manualEndpoint = endpointUrl(workerUrl, pathSecret);
  const commands = wranglerCommands({
    pathSecret,
    owner: settings.github.owner || '<owner>',
    repo: settings.github.repo || '<repo>',
    branch: settings.github.branch,
  });

  const copyAndOpen = (): void => {
    void navigator.clipboard?.writeText(endpoint).catch(() => undefined);
    if (openUrl !== undefined) void openUrl(CLAUDE_CONNECTORS);
    else globalThis.window?.open(CLAUDE_CONNECTORS, '_blank', 'noopener,noreferrer');
  };

  if (phone) {
    return (
      <div className="step">
        <h2>Let Claude help</h2>
        <p className="prose step-lead">
          Optional, and independent of everything else. Claude can list, add and finish tasks, start
          the timer, and make projects and tags. A change it makes is one event in the same log.
        </p>
        <p className="prose">
          The Claude app on this phone reaches your tasks through an endpoint on your own free
          Cloudflare account. The endpoint is deployed from the desktop app, once; this phone
          learns about it through sync.
        </p>
        <Flow label="The Claude endpoint">
          <FlowStep
            status={settings.worker.base === '' ? 'idle' : 'ok'}
            title={settings.worker.base === '' ? 'Deploy it from the desktop' : 'Endpoint deployed'}
            detail={
              settings.worker.base === ''
                ? 'On the desktop, open Settings, Claude, and press Sign in and deploy. It shows here as soon as the two sync.'
                : `Deployed from the desktop at ${settings.worker.base}.`
            }
          />
          <FlowStep status={settings.worker.base === '' ? 'idle' : 'ok'} title="Add it to Claude, on the desktop">
            <p className="prose">
              The endpoint URL is a credential and stays on the desktop that deployed it. There,
              press Copy the endpoint and open Claude, and add it under Customize, Connectors.
              Connectors belong to your Claude account, so the Claude app on this phone has it
              from then on. Nothing to do here.
            </p>
          </FlowStep>
        </Flow>
      </div>
    );
  }

  return (
    <div className="step">
      <h2>Let Claude help</h2>
      <p className="prose step-lead">
        Optional, and independent of everything else. Claude can list, add and finish tasks, start
        the timer, and make projects and tags. A change it makes is one event in the same log.
      </p>

      <h3 className="micro">Claude Code</h3>
      {claudeCode === undefined ? (
        <>
          <p className="prose">
            Runs a local server over stdio. No account, no network, nothing to deploy. Run this
            once in a terminal:
          </p>
          <Copyable text={mcpAddCommand(mcpServerPath ?? DEFAULT_MCP_PATH)} label="Copy the claude mcp add command" wrap />
          {mcpServerPath === undefined ? (
            <p className="field-hint">
              Run it from the repository root, or build the server first with{' '}
              <span className="mono">npm run build -w @to-hoot/mcp</span>.
            </p>
          ) : null}
        </>
      ) : (
        <Flow label="Registering with Claude Code">
          <FlowStep
            status={codeStale ? 'idle' : codeState.status}
            title={codeState.status === 'ok' && !codeStale ? 'Registered with Claude Code' : 'Add to Claude Code'}
            detail={codeStale ? 'The endpoint changed since this was registered. Add it again.' : codeState.detail}
            hint={codeState.hint}
          >
            <p className="field-hint">
              {settings.worker.url === ''
                ? 'Points Claude Code at the local server over stdio. Deploy the endpoint first and it points there instead, which needs no checkout on this machine.'
                : 'Points Claude Code at the deployed endpoint, the same one Claude on the web uses.'}
            </p>
            <div className="step-actions">
              <button
                type="button"
                className="button button-primary"
                disabled={codeState.status === 'running'}
                onClick={() => void addToClaudeCode()}
              >
                {codeState.status === 'ok' ? 'Add to Claude Code again' : 'Add to Claude Code'}
              </button>
            </div>
            <Reveal label="Use the command instead">
              <Copyable text={mcpAddCommand(mcpServerPath ?? DEFAULT_MCP_PATH)} label="Copy the claude mcp add command" wrap />
              <p className="field-hint">
                Run it from the repository root, or build the server first with{' '}
                <span className="mono">npm run build -w @to-hoot/mcp</span>.
              </p>
            </Reveal>
          </FlowStep>
        </Flow>
      )}

      <hr className="step-rule" />

      <h3 className="micro">Claude on the web and on your phone</h3>
      <p className="prose">
        Neither can reach a program on this machine, so they need an endpoint. This one runs on your
        own free Cloudflare account and answers only to a URL nobody else knows.
      </p>

      <Flow label="Deploying the Claude endpoint">
        <FlowStep
          status={signIn.status}
          title={deploy.status === 'ok' ? 'Signed in with Cloudflare' : 'Sign in with Cloudflare'}
          detail={signIn.detail}
          hint={signIn.hint}
        >
          {githubReady ? null : (
            <p className="field-hint">
              Connect sync first. The endpoint reads your data repository with that token, so there
              is nothing to deploy until there is one.
            </p>
          )}
          {signIn.status === 'running' ? (
            <div className="step-actions">
              <button type="button" className="button" onClick={cancelSignIn}>
                Cancel
              </button>
            </div>
          ) : (
            <div className="step-actions">
              <button
                type="button"
                className="button button-primary"
                disabled={busy || !canSignIn || !githubReady}
                onClick={() => void signInAndDeploy()}
              >
                {deploy.status === 'ok' ? 'Sign in and deploy again' : 'Sign in and deploy'}
              </button>
            </div>
          )}
          <p className="field-hint">
            {canSignIn
              ? 'A Cloudflare account is free and needs no payment method. Approve ToHoot in the browser and the endpoint deploys by itself.'
              : deployedElsewhere
                ? 'The endpoint was deployed from another device. Deploying again happens there.'
                : 'Cloudflare sends the sign-in back to the desktop app only. Deploy from there once; this device then shows the endpoint as deployed.'}
          </p>
          {accounts !== null && accounts.length > 1 ? (
            <div className="field">
              <label className="micro" htmlFor={field('account')}>
                Cloudflare account
              </label>
              <select
                id={field('account')}
                className="field-input"
                value={accountId}
                onChange={e => setAccountId(e.target.value)}
              >
                <option value="">Choose an account</option>
                {accounts.map(a => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
              <div className="step-actions">
                <button
                  type="button"
                  className="button button-primary"
                  disabled={busy || accountId === ''}
                  onClick={deployWithChosen}
                >
                  Deploy to this account
                </button>
              </div>
            </div>
          ) : null}
        </FlowStep>

        <FlowStep status={deploy.status} title="Deploy the endpoint" detail={deploy.detail} hint={deploy.hint}>
          <Reveal label="Path secret and token options">
            <SecretField
              id={field('path')}
              label="Path secret"
              value={pathSecret}
              readOnly
              hint="The endpoint is /mcp/<secret>, so the URL is the credential: treat it like a password."
            />
            <div className="step-actions">
              <button type="button" className="button" onClick={rotatePath} disabled={busy}>
                Generate a new path secret
              </button>
            </div>
            <p className="field-hint">
              Without signing in, an API token does the same deploy. Cloudflare opens on the token
              page with the two permissions already chosen. Press Create Token, copy it, and paste
              it here.
            </p>
            <div className="step-actions">
              <ExternalLink href={CLOUDFLARE_TOKEN_URL} openUrl={openUrl}>
                Open Cloudflare
              </ExternalLink>
            </div>
            <SecretField
              id={field('cf')}
              label="Cloudflare API token"
              value={apiToken}
              onChange={setApiToken}
              placeholder="Paste the token"
              hint="Used for this deploy and then forgotten. It is never stored."
            />
            <div className="step-actions">
              <button
                type="button"
                className="button"
                disabled={busy || apiToken.trim() === '' || !githubReady}
                onClick={() => void runDeploy(apiToken)}
              >
                {deploy.status === 'ok' ? 'Deploy again with the token' : 'Deploy with the token'}
              </button>
            </div>
          </Reveal>
          <p className="field-hint">
            The free plan allows 100,000 requests a day, and at the limit it answers with an error
            rather than a bill.
          </p>
        </FlowStep>

        <FlowStep status={endpoint === '' ? 'idle' : 'ok'} title="Add it to Claude">
          {endpoint === '' ? (
            <p className="field-hint">Once the endpoint is deployed, its URL appears here.</p>
          ) : (
            <>
              <Copyable text={endpoint} label="Copy the endpoint URL" wrap />
              <p className="prose">
                In Claude, open Customize, then Connectors, then Add custom connector. Paste the URL
                and leave authentication empty. The same connector then works on the web and in the
                Claude app on your phone.
              </p>
            </>
          )}
          <div className="step-actions">
            {endpoint === '' ? null : (
              <button type="button" className="button button-primary" onClick={copyAndOpen}>
                Copy the endpoint and open Claude
              </button>
            )}
            <ExternalLink href={CLAUDE_CONNECTORS} openUrl={openUrl}>
              Open Claude connectors
            </ExternalLink>
          </div>
        </FlowStep>
      </Flow>

      <Reveal label="Deploy with wrangler instead">
        <p className="prose">
          On a computer with this repository checked out. Each command prompts for the value in the
          comment beside it.
        </p>
        <Copyable text={commands} label="Copy the wrangler commands" />
        <div className="step-actions">
          <ExternalLink href={CLOUDFLARE_DASHBOARD} openUrl={openUrl}>
            Open the Cloudflare dashboard
          </ExternalLink>
          <ExternalLink href={SETUP_GUIDE} openUrl={openUrl}>
            Read the setup guide
          </ExternalLink>
        </div>
        <TextField
          id={field('worker')}
          label="Worker URL"
          value={workerUrl}
          onChange={setWorkerUrl}
          placeholder="https://to-hoot-mcp.<subdomain>.workers.dev"
          hint="Paste what wrangler printed when it deployed. The path secret is added for you."
        />
        <TestConnection
          label="Test endpoint"
          state={manualState}
          disabled={manualEndpoint === ''}
          onTest={() =>
            runManual(async () => {
              const check = await testWorker(http, manualEndpoint);
              if (check.status === 'ok') {
                onSave({ worker: { url: manualEndpoint, pathSecret, base: manualEndpoint.replace(/\/mcp\/.*$/, '') } });
                setDeploy({ status: 'ok', detail: `Endpoint: ${manualEndpoint}` });
              }
              return check;
            })
          }
        />
      </Reveal>
    </div>
  );
}
