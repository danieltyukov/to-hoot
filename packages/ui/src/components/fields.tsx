import { useEffect, useRef, useState, type ReactNode } from 'react';

import { CheckGlyph, ChevronGlyph } from '../icons/glyphs.js';
import type { Check } from '../setup.js';
import './fields.css';

/*
 * The controls the wizard and the settings screen share.
 *
 * Two rules run through all of them. Every icon-only control carries an
 * aria-label, because the Android suite addresses controls by accessible name
 * and an unnamed one is unreachable rather than merely awkward. And a secret is
 * never rendered as plain text by default, because setup is the one moment
 * someone is most likely to be sharing their screen.
 */

export function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = (): void => {
    // Absent in an insecure context and in some webviews. Failing quietly and
    // leaving the text selectable is better than an error nobody can act on.
    void navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(true);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 2000);
      },
      () => undefined,
    );
  };

  return (
    <button type="button" className="copy" aria-label={label} onClick={copy}>
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

/** A block of text to be copied out: a command, a script, a secret. */
export function Copyable({
  text,
  label,
  wrap = false,
}: {
  text: string;
  label: string;
  wrap?: boolean;
}) {
  return (
    <div className="copyable">
      <pre className="copyable-text mono" data-wrap={wrap ? '' : undefined}>
        {text}
      </pre>
      <CopyButton text={text} label={label} />
    </div>
  );
}

/**
 * A link out of the app, drawn as a button.
 *
 * Always an anchor, so a browser follows it the way a browser follows links,
 * with a middle click and a context menu and everything else people expect. The
 * two shells hand over `openUrl` and it is handled instead: a Tauri window and
 * an Android WebView are the application, so a link followed inside one either
 * navigates the app away from itself or silently does nothing.
 */
export function ExternalLink({
  href,
  openUrl,
  children,
}: {
  href: string;
  openUrl?: ((url: string) => Promise<void>) | undefined;
  children: ReactNode;
}) {
  return (
    <a
      className="button link-button"
      href={href}
      target="_blank"
      rel="noreferrer"
      onClick={
        openUrl === undefined
          ? undefined
          : event => {
              event.preventDefault();
              void openUrl(href);
            }
      }
    >
      {children}
    </a>
  );
}

export interface SecretFieldProps {
  id: string;
  label: string;
  value: string;
  onChange?: ((value: string) => void) | undefined;
  placeholder?: string;
  /** Generated secrets are shown, not typed. */
  readOnly?: boolean;
  hint?: ReactNode;
}

/**
 * A secret, masked, with a reveal.
 *
 * Masked by default rather than on request: the wizard is the one moment
 * someone is most likely to be screen-sharing, and a token that has been shown
 * once cannot be unshown.
 */
export function SecretField({
  id,
  label,
  value,
  onChange,
  placeholder,
  readOnly = false,
  hint,
}: SecretFieldProps) {
  const [shown, setShown] = useState(false);
  return (
    <div className="field">
      <label className="micro" htmlFor={id}>
        {label}
      </label>
      <div className="field-row">
        <input
          id={id}
          className="field-input mono"
          type={shown ? 'text' : 'password'}
          autoComplete="off"
          spellCheck={false}
          value={value}
          placeholder={placeholder}
          readOnly={readOnly}
          onChange={e => onChange?.(e.target.value)}
        />
        <button
          type="button"
          className="field-button"
          aria-pressed={shown}
          aria-label={shown ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
          onClick={() => setShown(s => !s)}
        >
          {shown ? 'Hide' : 'Show'}
        </button>
        {readOnly ? <CopyButton text={value} label={`Copy ${label.toLowerCase()}`} /> : null}
      </div>
      {hint === undefined ? null : <p className="field-hint">{hint}</p>}
    </div>
  );
}

export function TextField({
  id,
  label,
  value,
  onChange,
  placeholder,
  hint,
  invalid = false,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  hint?: ReactNode;
  invalid?: boolean;
}) {
  return (
    <div className="field">
      <label className="micro" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className="field-input"
        value={value}
        placeholder={placeholder}
        aria-invalid={invalid}
        autoComplete="off"
        spellCheck={false}
        onChange={e => onChange(e.target.value)}
      />
      {hint === undefined ? null : <p className="field-hint">{hint}</p>}
    </div>
  );
}

export type CheckState = { phase: 'idle' } | { phase: 'running' } | { phase: 'done'; check: Check<unknown> };

/**
 * A button that performs the real operation and reports what happened.
 *
 * The result is a live region, so the answer reaches a screen reader without
 * anyone having to go looking for it: the whole point of the button is that it
 * tells you something you did not know.
 */
/**
 * The outcome of a check, on its own.
 *
 * Split out because a step can offer two routes to the same end (create a
 * repository, or select one) and they share an outcome. Rendering a result
 * beside each button showed the same sentence twice, which reads as two things
 * having happened.
 */
export function CheckResult({ state }: { state: CheckState }) {
  return (
    <p className="test-result" role="status" data-status={resultStatus(state)}>
      {state.phase === 'running' ? 'Testing' : null}
      {state.phase === 'done' ? state.check.detail : null}
      {state.phase === 'done' && state.check.status === 'error' && state.check.hint !== undefined ? (
        <span className="test-hint">{state.check.hint}</span>
      ) : null}
    </p>
  );
}

export function TestConnection({
  label = 'Test connection',
  state,
  onTest,
  disabled = false,
}: {
  label?: string;
  state: CheckState;
  onTest: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="test">
      <button
        type="button"
        className="button"
        onClick={onTest}
        disabled={disabled || state.phase === 'running'}
      >
        {state.phase === 'running' ? 'Testing' : label}
      </button>
      <CheckResult state={state} />
    </div>
  );
}

function resultStatus(state: CheckState): string | undefined {
  if (state.phase !== 'done') return undefined;
  return state.check.status;
}

/** Runs a check and keeps its state. One per thing that can be tested. */
export function useCheck(): [CheckState, (run: () => Promise<Check<unknown>>) => Promise<void>, () => void] {
  const [state, setState] = useState<CheckState>({ phase: 'idle' });
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const run = async (fn: () => Promise<Check<unknown>>): Promise<void> => {
    setState({ phase: 'running' });
    let check: Check<unknown>;
    try {
      check = await fn();
    } catch (err) {
      // A check that throws is still an answer, and a wizard stuck on "Testing"
      // forever is worse than one that says what broke.
      check = { status: 'error', detail: err instanceof Error ? err.message : String(err) };
    }
    if (alive.current) setState({ phase: 'done', check });
  };

  return [state, run, () => setState({ phase: 'idle' })];
}

/**
 * A secondary path folded away under one line of text.
 *
 * A button rather than a `<details>` element, so the state is React's and the
 * toggle is a control every test harness and every screen reader already knows
 * how to press. Used for the routes that stay available but are no longer the
 * way most people go: a token instead of sign-in, wrangler instead of the
 * deploy button, another repository name.
 */
export function Reveal({
  label,
  children,
  defaultOpen = false,
}: {
  label: string;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="reveal" data-open={open ? '' : undefined}>
      <button type="button" className="reveal-toggle" aria-expanded={open} onClick={() => setOpen(o => !o)}>
        <ChevronGlyph className="reveal-chevron" />
        <span>{label}</span>
      </button>
      {open ? <div className="reveal-body">{children}</div> : null}
    </div>
  );
}

export type FlowStatus = 'idle' | 'running' | 'ok' | 'error';

/**
 * One line of a flow that runs itself: what it is, how it went, and whatever
 * it needs from the person under that.
 *
 * The connection flows used to be three buttons each with a result beside it,
 * and a person had to press them in order. This is the same information laid
 * out as the order it happens in, so watching it complete is the whole
 * interaction and a button only appears where a decision is genuinely theirs.
 */
export function FlowStep({
  status,
  title,
  detail,
  hint,
  children,
}: {
  status: FlowStatus;
  title: string;
  /** The result, when there is one: "Signed in as someone." */
  detail?: string | undefined;
  /** What to do about an error, on its own line. */
  hint?: string | undefined;
  children?: ReactNode;
}) {
  return (
    <li className="flow-step" data-status={status}>
      <span className="flow-mark" aria-hidden="true">
        {status === 'ok' ? <CheckGlyph /> : null}
      </span>
      <div className="flow-main">
        <p className="flow-title">{title}</p>
        {detail === undefined ? null : (
          <p className="flow-detail" role="status" data-status={status === 'idle' ? undefined : status}>
            {detail}
            {hint === undefined ? null : <span className="test-hint">{hint}</span>}
          </p>
        )}
        {children === undefined || children === null ? null : <div className="flow-body">{children}</div>}
      </div>
    </li>
  );
}

export function Flow({ children, label }: { children: ReactNode; label: string }) {
  return (
    <ol className="flow" aria-label={label}>
      {children}
    </ol>
  );
}
