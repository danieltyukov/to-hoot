import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { AgentEntry, AgentId, Http, LocalServer, Platform, Settings } from '@to-hoot/core';

import {
  AGENTS,
  CHATGPT_CONNECTORS,
  MIN_NODE_MAJOR,
  SERVER_NAME,
  TOKEN_PLACEHOLDER,
  fetchMcpBundle,
  localTarget,
  nodeTooOld,
  snippetFor,
  targetKey,
  type AgentSpec,
  type McpTarget,
} from '../../agents.js';
import { CheckGlyph } from '../../icons/glyphs.js';
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
  newOAuthAttempt,
  readCallback,
  revokeCloudflareToken,
  testWorker,
  wranglerCommands,
  type CloudflareAccount,
} from '../../setup.js';

export interface StepAgentsProps {
  http: Http;
  settings: Settings;
  onSave: (patch: Partial<Settings>) => void;
  /** The shell's way of opening a link, where the host will not follow one. */
  openUrl?: ((url: string) => Promise<void>) | undefined;
  /** The shell, for whether a sign-in can come back to it, and the agents' config files. */
  platform?: Pick<Platform, 'kind' | 'oauthLoopback' | 'agents'> | undefined;
}

/** Where the stdio server is in a checkout, for snippets written in a browser. */
const CHECKOUT_SERVER = 'apps/mcp/dist/index.js';

type Stage = { status: FlowStatus; detail?: string; hint?: string };

/*
 * Agents.
 *
 * Anything that speaks MCP can use the app: Claude, ChatGPT, Codex, Gemini
 * CLI, Cursor, VS Code and the rest all talk to the same fifteen tools. There
 * are two ways in, both optional and independent.
 *
 * An agent on this computer gets an entry in its own config file, written by
 * one press. The entry points at the endpoint when one is deployed, since that
 * needs nothing installed; otherwise at the local stdio server, which the app
 * downloads for its own version and runs with the person's node.
 *
 * An assistant in the browser or on a phone cannot reach a program on this
 * computer, so it needs the endpoint, which deploys from this screen with one
 * press. That press signs in with Cloudflare in the browser, using the same
 * public OAuth client wrangler uses, and then makes the same upload wrangler
 * makes: the app downloads the Worker built for this release, uploads it with
 * the four secrets as bindings, switches on its workers.dev route, and asks the
 * new endpoint for its tools. The token lives in memory for the deploy and is
 * revoked the moment it is done; it can rewrite every Worker on the account,
 * and a task app has no business keeping that.
 *
 * Cloudflare's client only redirects to localhost, so the sign-in needs the
 * desktop app. The phone learns the endpoint exists through sync and shows it
 * as deployed. A pasted API token and wrangler stay available, folded away.
 */
export function StepAgents({ http, settings, onSave, openUrl, platform }: StepAgentsProps) {
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
   * A phone neither runs a local agent nor deploys: Cloudflare's sign-in comes
   * back to a desktop only. What it can do is know whether the desktop has
   * deployed, which the hostname in the log tells it, and hand the person to
   * their assistant. So it gets that and none of the controls it cannot press.
   */
  const phone = platform?.kind === 'android';
  const endpoint = settings.worker.url;

  const open = (url: string): void => {
    if (openUrl !== undefined) void openUrl(url);
    else globalThis.window?.open(url, '_blank', 'noopener,noreferrer');
  };

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
      open(cloudflareAuthUrl(attempt));
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

  const copyAndOpen = (url: string): void => {
    void navigator.clipboard?.writeText(endpoint).catch(() => undefined);
    open(url);
  };

  const assistantsCopy = (
    <p className="prose">
      In Claude, open Customize, then Connectors, then Add custom connector, paste the URL and leave
      authentication empty. In ChatGPT, turn on developer mode under Settings, Apps and Connectors,
      Advanced, then create a connector with the URL and no authentication. Any other app that takes a
      remote MCP server URL works the same way. A connector belongs to your account, so the app on
      your phone has it too.
    </p>
  );

  if (phone) {
    return (
      <div className="step">
        <h2>Let an agent help</h2>
        <p className="prose step-lead">
          Optional, and independent of everything else. Any assistant that speaks MCP, such as Claude
          or ChatGPT, can list, add and finish tasks, start the timer, and make projects and tags. A
          change it makes is one event in the same log.
        </p>
        <p className="prose">
          An assistant on this phone reaches your tasks through an endpoint on your own free Cloudflare
          account. The endpoint is deployed from the desktop app, once; this phone learns about it
          through sync.
        </p>
        <Flow label="The endpoint">
          <FlowStep
            status={settings.worker.base === '' ? 'idle' : 'ok'}
            title={settings.worker.base === '' ? 'Deploy it from the desktop' : 'Endpoint deployed'}
            detail={
              settings.worker.base === ''
                ? 'On the desktop, open Settings, Agents, and press Sign in and deploy. It shows here as soon as the two sync.'
                : `Deployed from the desktop at ${settings.worker.base}.`
            }
          />
          <FlowStep status={settings.worker.base === '' ? 'idle' : 'ok'} title="Add it to your assistant, on the desktop">
            <p className="prose">
              The endpoint URL is a credential and stays on the desktop that deployed it. There, copy
              it and add it as a connector in Claude or ChatGPT. Connectors belong to your account, so
              the app on this phone has it from then on. Nothing to do here.
            </p>
          </FlowStep>
        </Flow>
      </div>
    );
  }

  return (
    <div className="step">
      <h2>Let an agent help</h2>
      <p className="prose step-lead">
        Optional, and independent of everything else. Any assistant that speaks MCP, the open protocol
        Claude, ChatGPT, Codex, Gemini, Cursor and VS Code share, can list, add and finish tasks, start
        the timer, and make projects and tags. A change it makes is one event in the same log.
      </p>

      <h3 className="micro">Agents on this computer</h3>
      <LocalAgents http={http} settings={settings} githubReady={githubReady} platform={platform} />

      <hr className="step-rule" />

      <h3 className="micro">Assistants in the browser and on your phone</h3>
      <p className="prose">
        Claude and ChatGPT on the web and on a phone cannot reach a program on this computer, so they
        need an endpoint. This one runs on your own free Cloudflare account and answers only to a URL
        nobody else knows.
      </p>

      <Flow label="Deploying the endpoint">
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

        <FlowStep status={endpoint === '' ? 'idle' : 'ok'} title="Add it to your assistant">
          {endpoint === '' ? (
            <p className="field-hint">Once the endpoint is deployed, its URL appears here.</p>
          ) : (
            <>
              <Copyable text={endpoint} label="Copy the endpoint URL" wrap />
              {assistantsCopy}
            </>
          )}
          <div className="step-actions">
            {endpoint === '' ? (
              <>
                <ExternalLink href={CLAUDE_CONNECTORS} openUrl={openUrl}>
                  Open Claude connectors
                </ExternalLink>
                <ExternalLink href={CHATGPT_CONNECTORS} openUrl={openUrl}>
                  Open ChatGPT settings
                </ExternalLink>
              </>
            ) : (
              <>
                <button type="button" className="button button-primary" onClick={() => copyAndOpen(CLAUDE_CONNECTORS)}>
                  Copy and open Claude
                </button>
                <button type="button" className="button" onClick={() => copyAndOpen(CHATGPT_CONNECTORS)}>
                  Copy and open ChatGPT
                </button>
              </>
            )}
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

/** Whether a target read back from a config file is a URL rather than a program. */
const isUrl = (target: string): boolean => /^https?:\/\//i.test(target);

/*
 * The agents on this computer, one row each.
 *
 * A row is the agent, whether it looks installed, whether the app's entry is in
 * its config and still points at the right place, and one button. The entry is
 * stale when the endpoint changed under it (a redeploy with a new path secret)
 * or when it points at the local server and an endpoint now exists, or the
 * other way round.
 */
function LocalAgents({
  http,
  settings,
  githubReady,
  platform,
}: {
  http: Http;
  settings: Settings;
  githubReady: boolean;
  platform?: Pick<Platform, 'agents'> | undefined;
}) {
  const configs = platform?.agents;
  const endpoint = settings.worker.url;
  const [entries, setEntries] = useState<Partial<Record<AgentId, AgentEntry>>>({});
  const [rows, setRows] = useState<Partial<Record<AgentId, Stage>>>({});
  /** The local server once installed this session, so seven presses download it once. */
  const installed = useRef<LocalServer | null>(null);

  useEffect(() => {
    if (configs === undefined) return;
    let live = true;
    for (const agent of AGENTS) {
      configs
        .inspect(agent.id, agent.key, SERVER_NAME)
        .then(entry => {
          if (live) setEntries(e => ({ ...e, [agent.id]: entry }));
        })
        .catch(() => undefined);
    }
    return () => {
      live = false;
    };
  }, [configs]);

  const setRow = (id: AgentId, stage: Stage): void => setRows(r => ({ ...r, [id]: stage }));

  const ensureServer = useCallback(async (): Promise<
    { ok: true; server: LocalServer } | { ok: false; detail: string; hint?: string | undefined }
  > => {
    if (installed.current !== null) return { ok: true, server: installed.current };
    if (configs === undefined) return { ok: false, detail: 'This device cannot run agents.' };
    const bundle = await fetchMcpBundle(http);
    if (bundle.status === 'error') return { ok: false, detail: bundle.detail, hint: bundle.hint };
    try {
      installed.current = await configs.installServer(bundle.value);
      return { ok: true, server: installed.current };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }, [configs, http]);

  const add = async (agent: AgentSpec): Promise<void> => {
    if (configs === undefined) return;
    let target: McpTarget;
    let warning: string | undefined;
    if (endpoint !== '') {
      target = { kind: 'remote', url: endpoint };
    } else {
      setRow(agent.id, { status: 'running', detail: 'Downloading the local server for this version.' });
      const server = await ensureServer();
      if (!server.ok) {
        setRow(agent.id, { status: 'error', detail: server.detail, hint: server.hint });
        return;
      }
      target = localTarget(settings.github, server.server);
      if (server.server.node === null) {
        warning = `No Node.js was found on this computer. Install Node.js ${MIN_NODE_MAJOR} or newer and add it again, or deploy the endpoint below.`;
      } else if (nodeTooOld(server.server.nodeVersion)) {
        warning = `The Node.js here is ${server.server.nodeVersion}, and the server needs ${MIN_NODE_MAJOR} or newer.`;
      }
    }
    setRow(agent.id, { status: 'running', detail: `Writing it into ${agent.name}’s settings.` });
    try {
      const path = await configs.add(agent.id, agent.key, SERVER_NAME, agent.entry(target));
      setEntries(e => ({
        ...e,
        [agent.id]: { path, installed: e[agent.id]?.installed ?? true, present: true, target: targetKey(target) },
      }));
      setRow(
        agent.id,
        warning === undefined
          ? { status: 'ok', detail: `Added to ${path}. ${agent.name} picks it up the next time it starts.` }
          : { status: 'error', detail: `Added to ${path}, but it will not start yet.`, hint: warning },
      );
    } catch (err) {
      setRow(agent.id, { status: 'error', detail: err instanceof Error ? err.message : String(err) });
    }
  };

  const manualId = useId();
  const [manual, setManual] = useState<AgentId>('claude-code');
  const manualAgent = AGENTS.find(a => a.id === manual) ?? AGENTS[0]!;
  const manualTarget: McpTarget =
    endpoint !== ''
      ? { kind: 'remote', url: endpoint }
      : localTarget(settings.github, { path: installed.current?.path ?? CHECKOUT_SERVER, node: installed.current?.node ?? null }, TOKEN_PLACEHOLDER);

  const intro =
    endpoint !== ''
      ? 'Each button writes one entry into that agent’s own settings and leaves the rest of the file alone. The entry points at your endpoint, so nothing runs on this computer.'
      : `Each button writes one entry into that agent’s own settings and leaves the rest of the file alone. The entry runs a small local server that ships with this version of ToHoot and needs Node.js ${MIN_NODE_MAJOR} or newer. Deploy the endpoint below and add again to use that instead.`;

  return (
    <>
      <p className="prose">{intro}</p>
      {githubReady || endpoint !== '' ? null : (
        <p className="field-hint">
          Connect sync first. An agent reads your tasks from the data repository, so there is nothing
          to point it at until there is one.
        </p>
      )}

      {configs === undefined ? null : (
        <ul className="agent-list" aria-label="Agents on this computer">
          {AGENTS.map(agent => {
            const entry = entries[agent.id];
            const row = rows[agent.id];
            const stale =
              entry?.present === true &&
              entry.target !== null &&
              (endpoint !== '' ? entry.target !== endpoint : isUrl(entry.target));
            const added = entry?.present === true && !stale;
            const status: FlowStatus = row?.status ?? (added ? 'ok' : 'idle');
            const detail =
              row?.detail ??
              (stale
                ? endpoint !== ''
                  ? 'Points somewhere else. Add it again to use your endpoint.'
                  : 'Points at an endpoint. Add it again to use the local server.'
                : added
                  ? `Added to ${entry.path}.`
                  : entry === undefined
                    ? agent.file
                    : entry.installed
                      ? `Found on this computer. ${entry.path}`
                      : `Not found on this computer. ${entry.path}`);
            return (
              <li key={agent.id} className="agent-row" data-status={status} data-agent={agent.id}>
                <span className="flow-mark agent-mark" aria-hidden="true">
                  {status === 'ok' ? <CheckGlyph /> : null}
                </span>
                <div className="agent-main">
                  <p className="agent-name">
                    {agent.name}
                    {entry?.installed === true && !added ? <span className="agent-found">Found</span> : null}
                  </p>
                  <p className="agent-detail" role="status" data-status={status === 'idle' ? undefined : status}>
                    {detail}
                    {row?.hint === undefined ? null : <span className="test-hint">{row.hint}</span>}
                  </p>
                </div>
                <button
                  type="button"
                  className="button agent-add"
                  aria-label={`${added || stale ? 'Add again to' : 'Add to'} ${agent.name}`}
                  disabled={row?.status === 'running' || (!githubReady && endpoint === '')}
                  onClick={() => void add(agent)}
                >
                  {added || stale ? 'Add again' : 'Add'}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <Reveal label={configs === undefined ? 'Add it to an agent by hand' : 'Add it by hand instead'} defaultOpen={configs === undefined}>
        <div className="field">
          <label className="micro" htmlFor={manualId}>
            Agent
          </label>
          <select
            id={manualId}
            className="field-input"
            value={manual}
            onChange={e => setManual(e.target.value as AgentId)}
          >
            {AGENTS.map(a => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </div>
        <p className="field-hint">
          Merge this into <span className="mono">{manualAgent.file}</span>.
          {manualTarget.kind === 'local'
            ? ' Put a GitHub token that can read and write the data repository where the placeholder is.'
            : ' The URL is a credential: keep the file to yourself.'}
        </p>
        <Copyable text={snippetFor(manualAgent, manualTarget)} label={`Copy the ${manualAgent.name} entry`} />
      </Reveal>
    </>
  );
}
