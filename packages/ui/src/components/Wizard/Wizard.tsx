import { useState, type ReactNode } from 'react';
import type { Http, Settings } from '@to-hoot/core';

import { OwlMark } from '../../icons/OwlMark.js';
import { Wordmark } from '../Wordmark.js';
import { StepCalendar } from './StepCalendar.js';
import { StepClaude } from './StepClaude.js';
import { StepLocal } from './StepLocal.js';
import { StepSync } from './StepSync.js';
import './Wizard.css';

export type StepId = 'local' | 'sync' | 'calendar' | 'claude';

export const STEPS: ReadonlyArray<{ id: StepId; title: string }> = [
  { id: 'local', title: 'Local' },
  { id: 'sync', title: 'Sync' },
  { id: 'calendar', title: 'Calendar' },
  { id: 'claude', title: 'Claude' },
];

export interface WizardProps {
  http: Http;
  settings: Settings;
  /** Merged into settings and written to the platform store, never to the log. */
  onSave: (patch: Partial<Settings>) => void;
  onDone: () => void;
  /** Absolute path to the built MCP server, for the generated command. */
  mcpServerPath?: string;
  /** True when the app draws the window frame, so the header leaves room for it. */
  chrome?: boolean;
}

/*
 * First run.
 *
 * The shape of this screen is an argument about the product: step one is that
 * there is nothing to do. Everything after it is optional, skippable, and
 * reachable again from Settings, because a local task tracker with a timer is a
 * complete thing and nobody should have to hand over a GitHub token to use one.
 *
 * Every step ends in a check that performs the real operation rather than
 * validating a string. A wizard that accepts a well-formed token and a
 * well-formed URL and then fails a week later, in the background, with no
 * wizard on screen, has moved the problem rather than solved it.
 */
export function Wizard({ http, settings, onSave, onDone, mcpServerPath, chrome }: WizardProps) {
  const [at, setAt] = useState(0);
  const step = STEPS[at]!;
  const isLast = at === STEPS.length - 1;

  const next = (): void => {
    if (isLast) onDone();
    else setAt(i => i + 1);
  };

  const body: Record<StepId, ReactNode> = {
    local: <StepLocal />,
    sync: <StepSync http={http} settings={settings} onSave={onSave} />,
    calendar: <StepCalendar http={http} settings={settings} onSave={onSave} />,
    claude: <StepClaude http={http} settings={settings} onSave={onSave} mcpServerPath={mcpServerPath} />,
  };

  return (
    <section className="wizard" aria-label="Setup" data-chrome={chrome ? 'app' : undefined}>
      <header className="wizard-head">
        <div className="brand">
          <OwlMark size={22} label={null} className="brand-mark" />
          <Wordmark className="brand-word" />
        </div>
        <ol className="wizard-steps">
          {STEPS.map((s, i) => (
            <li key={s.id}>
              <button
                type="button"
                className="wizard-step"
                data-step={s.id}
                aria-current={i === at ? 'step' : undefined}
                data-visited={i < at ? '' : undefined}
                onClick={() => setAt(i)}
              >
                {s.title}
              </button>
            </li>
          ))}
        </ol>
      </header>

      <div className="wizard-body" data-current={step.id}>
        {body[step.id]}
      </div>

      <footer className="wizard-foot">
        <button
          type="button"
          className="button"
          onClick={() => setAt(i => Math.max(0, i - 1))}
          disabled={at === 0}
        >
          Back
        </button>
        <span className="wizard-spacer" />
        {/* Skipping is a first-class action, not an escape hatch in small
            print. Everything after step one is genuinely optional. */}
        {at === 0 ? null : (
          <button type="button" className="button" onClick={next}>
            Skip this
          </button>
        )}
        <button type="button" className="button wizard-next" onClick={next}>
          {isLast ? 'Finish' : 'Next'}
        </button>
      </footer>
    </section>
  );
}
