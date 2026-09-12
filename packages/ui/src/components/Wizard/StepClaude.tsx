import { useEffect, useId, useState } from 'react';
import type { Http, Settings } from '@to-hoot/core';

import {
  Copyable,
  ExternalLink,
  SecretField,
  TestConnection,
  TextField,
  useCheck,
} from '../fields.js';
import {
  CLAUDE_CONNECTORS,
  CLOUDFLARE_DASHBOARD,
  SETUP_GUIDE,
  endpointUrl,
  generateSecret,
  mcpAddCommand,
  testWorker,
  wranglerCommands,
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

/*
 * Claude.
 *
 * Two independent paths, and both are optional. Claude Code talks to a local
 * process over stdio and needs no account and no network. Claude on the web and
 * on a phone cannot reach a local process at all, so they need an endpoint,
 * which means the user's own free Cloudflare account.
 *
 * Neither is offered as the obvious choice, because which one is right depends
 * entirely on where the person actually uses Claude.
 *
 * The second path is numbered, and says out loud which stage happens on a
 * computer. This component is rendered in four places between them, the wizard
 * and Settings on a desktop and on a phone, and the phone is where an
 * unexplained wall of shell commands is worse than useless: there is no
 * terminal to run them in, and nothing on the screen said so.
 *
 * Nothing here deploys anything on the user's behalf. Cloudflare's one-click
 * deploy button treats the linked subdirectory as the root of a new repository
 * and requires the application to be self-contained inside it, which
 * `apps/worker` is not: it depends on `@to-hoot/core` through the workspace. A
 * button that produces a repository which cannot build is worse than a command
 * that works.
 */
export function StepClaude({ http, settings, onSave, mcpServerPath, openUrl }: StepClaudeProps) {
  const ids = useId();
  const field = (name: string): string => `${ids}-${name}`;

  /*
   * Generated once and stored, not on every mount.
   *
   * Regenerating it here meant reopening this step showed a different
   * MCP_PATH_SECRET from the endpoint URL sitting beside it, so following the
   * commands quietly broke the endpoint that was already saved.
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

  const [workerUrl, setWorkerUrl] = useState(settings.worker.url);
  const [state, run] = useCheck();

  /*
   * What the user pastes is what `wrangler deploy` printed, and what Claude
   * needs is that plus the path the endpoint answers on. Assembling the two by
   * hand is the step people get wrong, and every way of getting it wrong
   * arrives as the same 404 a Worker that is down would give.
   */
  const endpoint = endpointUrl(workerUrl, pathSecret);

  const command = mcpAddCommand(mcpServerPath ?? DEFAULT_MCP_PATH);
  const commands = wranglerCommands({
    pathSecret,
    owner: settings.github.owner || '<owner>',
    repo: settings.github.repo || '<repo>',
    // From settings, not a literal. Hardcoding main here omitted GITHUB_BRANCH
    // from the deploy block on a master repository, so the Worker that serves
    // Claude on the web ran against a branch the app never writes to.
    branch: settings.github.branch,
  });

  return (
    <div className="step">
      <h2>Let Claude help</h2>
      <p className="prose step-lead">
        Optional, and independent of everything else. Skipping this leaves the rest working.
      </p>

      <h3 className="micro">Claude Code</h3>
      <p className="prose">
        Runs a local server over stdio. No account, no network, nothing to deploy. Run this once:
      </p>
      <Copyable text={command} label="Copy the claude mcp add command" wrap />
      {mcpServerPath === undefined ? (
        <p className="field-hint">
          Run it from the repository root, or build the server first with{' '}
          <span className="mono">npm run build -w @to-hoot/mcp</span>.
        </p>
      ) : null}

      <hr className="step-rule" />

      <h3 className="micro">Claude on the web, on your phone, and Cowork</h3>
      <p className="prose">
        None of them can reach a program on this machine, so they need an endpoint. This one runs
        on your own free Cloudflare account and answers only to a URL nobody else knows.
      </p>

      <ol className="step-numbered step-stages">
        <li>
          <h4 className="step-stage-head">Deploy the endpoint</h4>
          <p className="prose">
            Once, on a computer with this repository checked out. Each command below prompts for
            the value in the comment beside it.
          </p>

          <SecretField
            id={field('path')}
            label="Path secret"
            value={pathSecret}
            readOnly
            hint="The endpoint is /mcp/<secret>, so the URL is the credential: treat it like a password."
          />
          <div className="step-actions">
            <button type="button" className="button" onClick={rotatePath}>
              Generate a new path secret
            </button>
          </div>

          <Copyable text={commands} label="Copy the wrangler commands" />

          <div className="step-actions">
            <ExternalLink href={CLOUDFLARE_DASHBOARD} openUrl={openUrl}>
              Open Cloudflare
            </ExternalLink>
            <ExternalLink href={SETUP_GUIDE} openUrl={openUrl}>
              Read the setup guide
            </ExternalLink>
          </div>
          <p className="field-hint">
            A Cloudflare account is free and needs no payment method. The Worker free plan allows
            100,000 requests a day, and at the limit it answers with an error rather than a bill.
          </p>
        </li>

        <li>
          <h4 className="step-stage-head">Tell this app where it landed</h4>
          <TextField
            id={field('worker')}
            label="Worker URL"
            value={workerUrl}
            onChange={setWorkerUrl}
            placeholder="https://to-hoot-mcp.<subdomain>.workers.dev"
            hint="Paste what wrangler printed when it deployed. The path secret is added for you."
          />

          {endpoint === '' ? null : (
            <div className="field">
              <span className="micro">The endpoint</span>
              <Copyable text={endpoint} label="Copy the endpoint URL" wrap />
            </div>
          )}

          <TestConnection
            label="Test endpoint"
            state={state}
            disabled={endpoint === ''}
            onTest={() =>
              run(async () => {
                const check = await testWorker(http, endpoint);
                if (check.status === 'ok') {
                  onSave({ worker: { url: endpoint, pathSecret } });
                }
                return check;
              })
            }
          />
          <p className="field-hint">
            Asks the endpoint for its tool list, so a pass means Claude can really call it.
          </p>
        </li>

        <li>
          <h4 className="step-stage-head">Add it to Claude</h4>
          <p className="prose">
            In Claude, open Customize, then Connectors, then Add custom connector. Paste the
            endpoint URL and leave the second step empty, since this endpoint has no
            authentication to configure. The same connector then works in Claude on the web and
            in the Claude app on your phone.
          </p>
          <div className="step-actions">
            <ExternalLink href={CLAUDE_CONNECTORS} openUrl={openUrl}>
              Open Claude connectors
            </ExternalLink>
          </div>
        </li>
      </ol>
    </div>
  );
}
