import { useEffect, useId, useState } from 'react';
import type { Http, Settings } from '@to-hoot/core';

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
  deployWorker,
  endpointUrl,
  fetchWorkerBundle,
  generateSecret,
  listCloudflareAccounts,
  mcpAddCommand,
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
}

const DEFAULT_MCP_PATH = 'apps/mcp/dist/index.js';

type Stage = { status: FlowStatus; detail?: string; hint?: string };

/*
 * Claude.
 *
 * Two independent paths, both optional. Claude Code talks to a local process
 * over stdio and needs nothing but a command pasted once. Claude on the web and
 * on a phone cannot reach a local process, so they need an endpoint, and the
 * endpoint now deploys from this screen.
 *
 * The deploy is the same upload wrangler makes, sent to Cloudflare's API with a
 * token the person creates on one page: the app downloads the Worker built for
 * this release, uploads it with the four secrets as bindings, switches on its
 * workers.dev route, and asks the new endpoint for its tools. Every stage is a
 * line that fills in. The token is used once and never stored; it can rewrite
 * every Worker on the account, and a task app has no business keeping that.
 *
 * Wrangler stays available, folded away, for a terminal person or a fork with
 * no release to download from.
 */
export function StepClaude({ http, settings, onSave, mcpServerPath, openUrl }: StepClaudeProps) {
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

  // The deploy, stage by stage.
  const [apiToken, setApiToken] = useState('');
  const [accounts, setAccounts] = useState<CloudflareAccount[] | null>(null);
  const [accountId, setAccountId] = useState('');
  const [deploy, setDeploy] = useState<Stage>(
    settings.worker.url === '' ? { status: 'idle' } : { status: 'ok', detail: `Endpoint: ${settings.worker.url}` },
  );
  const [busy, setBusy] = useState(false);

  const runDeploy = async (): Promise<void> => {
    setBusy(true);
    try {
      setDeploy({ status: 'running', detail: 'Checking the Cloudflare token.' });
      const found = await listCloudflareAccounts(http, apiToken);
      if (found.status === 'error') {
        setDeploy({ status: 'error', detail: found.detail, hint: found.hint });
        return;
      }
      setAccounts(found.value);
      const chosen = found.value.length === 1 ? found.value[0]!.id : accountId;
      if (chosen === '') {
        setDeploy({ status: 'error', detail: 'The token can see more than one account. Choose one.' });
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
        apiToken,
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
      onSave({ worker: { url: result.value.endpoint, pathSecret } });
      setDeploy({ status: 'ok', detail: result.detail });
    } finally {
      // Forgotten on purpose, whatever happened. See the note at the top.
      setApiToken('');
      setBusy(false);
    }
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

  return (
    <div className="step">
      <h2>Let Claude help</h2>
      <p className="prose step-lead">
        Optional, and independent of everything else. Claude can list, add and finish tasks, start
        the timer, and make projects and tags. A change it makes is one event in the same log.
      </p>

      <h3 className="micro">Claude Code</h3>
      <p className="prose">
        Runs a local server over stdio. No account, no network, nothing to deploy. Run this once in
        a terminal:
      </p>
      <Copyable text={mcpAddCommand(mcpServerPath ?? DEFAULT_MCP_PATH)} label="Copy the claude mcp add command" wrap />
      {mcpServerPath === undefined ? (
        <p className="field-hint">
          Run it from the repository root, or build the server first with{' '}
          <span className="mono">npm run build -w @to-hoot/mcp</span>.
        </p>
      ) : null}

      <hr className="step-rule" />

      <h3 className="micro">Claude on the web and on your phone</h3>
      <p className="prose">
        Neither can reach a program on this machine, so they need an endpoint. This one runs on your
        own free Cloudflare account and answers only to a URL nobody else knows.
      </p>

      <Flow label="Deploying the Claude endpoint">
        <FlowStep
          status={apiToken.trim() !== '' || deploy.status === 'ok' ? 'ok' : 'idle'}
          title="Create a Cloudflare token"
        >
          <p className="field-hint">
            Cloudflare opens on the token page with the two permissions already chosen. Press Create
            Token, copy it, and paste it here. If the form did not fill itself in, pick the Edit
            Cloudflare Workers template.
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
            </div>
          ) : null}
        </FlowStep>

        <FlowStep status={deploy.status} title="Deploy the endpoint" detail={deploy.detail} hint={deploy.hint}>
          {githubReady ? null : (
            <p className="field-hint">
              Connect sync first. The endpoint reads your data repository with that token, so there
              is nothing to deploy until there is one.
            </p>
          )}
          <SecretField
            id={field('path')}
            label="Path secret"
            value={pathSecret}
            readOnly
            hint="The endpoint is /mcp/<secret>, so the URL is the credential: treat it like a password."
          />
          <div className="step-actions">
            <button
              type="button"
              className="button button-primary"
              disabled={busy || apiToken.trim() === '' || !githubReady}
              onClick={() => void runDeploy()}
            >
              {deploy.status === 'ok' ? 'Deploy again' : 'Deploy endpoint'}
            </button>
            <button type="button" className="button" onClick={rotatePath} disabled={busy}>
              Generate a new path secret
            </button>
          </div>
          <p className="field-hint">
            A Cloudflare account is free and needs no payment method. The free plan allows 100,000
            requests a day, and at the limit it answers with an error rather than a bill.
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
                onSave({ worker: { url: manualEndpoint, pathSecret } });
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
