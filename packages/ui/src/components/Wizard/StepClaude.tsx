import { useEffect, useId, useState } from 'react';
import type { Http, Settings } from '@to-hoot/core';

import { Copyable, SecretField, TestConnection, TextField, useCheck } from '../fields.js';
import { generateSecret, mcpAddCommand, testWorker, wranglerCommands } from '../../setup.js';

export interface StepClaudeProps {
  http: Http;
  settings: Settings;
  onSave: (patch: Partial<Settings>) => void;
  mcpServerPath?: string;
}

const DEFAULT_MCP_PATH = 'apps/mcp/dist/index.js';

/*
 * Claude.
 *
 * Two independent paths, and both are optional. Claude Code talks to a local
 * process over stdio and needs no account and no network. Claude on the web
 * cannot reach a local process at all, so it needs an endpoint, which means the
 * user's own free Cloudflare account.
 *
 * Neither is offered as the obvious choice, because which one is right depends
 * entirely on where the person actually uses Claude.
 */
export function StepClaude({ http, settings, onSave, mcpServerPath }: StepClaudeProps) {
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

      <h3 className="micro">Claude on the web, and Cowork</h3>
      <p className="prose">
        Neither can reach a program on this machine, so they need an endpoint. This one runs on
        your own free Cloudflare account and answers only to a URL nobody else knows.
      </p>

      <SecretField
        id={field('path')}
        label="Path secret"
        value={pathSecret}
        readOnly
        hint="Generated here. The endpoint is /mcp/<secret>, so the URL is the credential: treat it like a password."
      />
      <div className="step-actions">
        <button type="button" className="button" onClick={rotatePath}>
          Generate a new path secret
        </button>
      </div>

      <p className="prose">Then run these. Each prompts for the value in the comment beside it.</p>
      <Copyable text={commands} label="Copy the wrangler commands" />

      <TextField
        id={field('worker')}
        label="Endpoint URL"
        value={workerUrl}
        onChange={setWorkerUrl}
        placeholder="https://to-hoot-mcp.<subdomain>.workers.dev/mcp/<secret>"
        hint="Wrangler prints the base URL when it deploys. Add /mcp/ and the path secret."
      />

      <TestConnection
        label="Test endpoint"
        state={state}
        disabled={workerUrl.trim() === ''}
        onTest={() =>
          run(async () => {
            const check = await testWorker(http, workerUrl);
            if (check.status === 'ok') {
              onSave({ worker: { url: workerUrl.trim(), pathSecret } });
            }
            return check;
          })
        }
      />
      <p className="field-hint">
        Asks the endpoint for its tool list, so a pass means Claude can really call it. Add the URL
        as a custom connector in Claude, with authentication set to none.
      </p>
    </div>
  );
}
