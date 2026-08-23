// @vitest-environment node
// A standing audit of every stylesheet in the package.
//
// These are not style preferences dressed up as tests. Each one is a specific
// thing that makes an interface look machine-generated, and each is the kind of
// thing that arrives one file at a time: a third radius here, a gradient there,
// an indigo that came in with a copied snippet. Catching them per file, at the
// moment they are added, is the only point at which they are cheap to remove.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('.', import.meta.url));

function stylesheets(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) stylesheets(full, found);
    else if (entry.name.endsWith('.css')) found.push(full);
  }
  return found;
}

const FILES = stylesheets(SRC).map(path => ({
  name: path.slice(SRC.length),
  css: readFileSync(path, 'utf8'),
}));

/** Declarations outside comments, as "property: value" pairs. */
function declarations(css: string): Array<[string, string]> {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: Array<[string, string]> = [];
  for (const [, prop, value] of clean.matchAll(/([a-z-]+)\s*:\s*([^;{}]+)[;}]/g)) {
    out.push([prop!.trim(), value!.trim()]);
  }
  return out;
}

const TOKENS = 'tokens.css';

it('finds the stylesheets it is meant to audit', () => {
  expect(FILES.length).toBeGreaterThan(2);
  expect(FILES.map(f => f.name)).toContain(TOKENS);
});

describe.each(FILES)('$name', ({ name, css }) => {
  const decls = declarations(css);
  const isTokens = name === TOKENS;

  it('uses only the radius token, plus a full round for pills and dots', () => {
    // 50% is a dot and 999px is a pill; everything with corners takes the
    // token. A literal 6px is rejected even though it is the same number today,
    // because a literal is a value nobody has to keep in step with the token.
    const allowed = new Set(['var(--r-control)', '50%', '999px']);
    // One exception, and it is scoped to the single file that earns it: the
    // consistency cell is 11px, and 6px on an 11px square is a dot.
    if (name.endsWith('ConsistencyGrid.css')) allowed.add('2px');
    for (const [prop, value] of decls) {
      if (!prop.startsWith('border') || !prop.includes('radius')) continue;
      expect(allowed.has(value), `${prop}: ${value}`).toBe(true);
    }
  });

  it('names no colour outside the token sheet', () => {
    if (isTokens) return;
    // Project and tag colours are user data and arrive as inline styles. A hex
    // written into a stylesheet is a colour nobody chose twice.
    const literals = css.replace(/\/\*[\s\S]*?\*\//g, '').match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
    expect(literals).toEqual([]);
  });

  it('has no purple, indigo or the stock framework blue', () => {
    const banned = /#(6366f1|8b5cf6|a855f7|3b82f6|7c3aed|4f46e5|818cf8|60a5fa)\b/i;
    expect(css).not.toMatch(banned);
  });

  it('has no gradient, blur or glass', () => {
    expect(css).not.toMatch(/linear-gradient|radial-gradient|conic-gradient/);
    expect(css).not.toMatch(/backdrop-filter/);
    expect(css).not.toMatch(/filter:\s*blur/);
  });

  it('never puts a border and a shadow on the same element', () => {
    // Dense lists want a hairline or a lift, never both. Both together is the
    // look of a card component pulled in from somewhere else.
    const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const [, body] of clean.matchAll(/\{([^{}]*)\}/g)) {
      const hasBorder = /(^|[\s;])border(-(top|right|bottom|left|inline|block)[a-z-]*)?\s*:\s*(?!0|none)/m.test(
        body!,
      );
      const hasShadow = /(^|[\s;])box-shadow\s*:\s*(?!none)/m.test(body!);
      // An inset shadow is a rule, not a lift: the composer underlines its own
      // focus state that way, and that is not the card look this guards against.
      const isInset = /box-shadow\s*:\s*inset/.test(body!);
      expect(hasBorder && hasShadow && !isInset, body!.trim()).toBe(false);
    }
  });

  it('does not grow or move anything under the pointer', () => {
    const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const [, selector, body] of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!/:hover|:active/.test(selector!)) continue;
      expect(body).not.toMatch(/transform\s*:\s*(scale|translate)/);
    }
  });

  it('spells every duration and curve as a token', () => {
    for (const [prop, value] of decls) {
      if (prop !== 'transition' && prop !== 'animation' && prop !== 'transition-duration') continue;
      // A trailing delay in milliseconds is allowed; a bare duration is not.
      const bare = value.match(/(^|\s)\d+m?s\b/g) ?? [];
      expect(bare.length, `${prop}: ${value}`).toBeLessThanOrEqual(1);
      expect(value).not.toMatch(/cubic-bezier\(/);
      expect(value).not.toMatch(/\bease-in-out\b|\bease-out\b|\bspring\b/);
    }
  });

  it('names no font family outside the token sheet', () => {
    if (isTokens) return;
    for (const [prop, value] of decls) {
      if (prop !== 'font-family') continue;
      expect(value).toMatch(/^var\(--font-(sans|serif|mono)\)$/);
    }
  });

  it('contains no emoji', () => {
    expect(css).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u);
  });
});

it('grants the 11px grid cell its radius exception and nothing else', () => {
  // The allowance above is per file; this pins it to the one selector, so the
  // exception cannot quietly spread through the sheet that holds it.
  const grid = FILES.find(f => f.name.endsWith('ConsistencyGrid.css'))!.css;
  const exceptions = [...grid.matchAll(/([^{}]+)\{[^{}]*border-radius:\s*2px/g)];
  expect(exceptions.map(m => m[1]!.trim().split('\n').pop()!.trim())).toEqual(['.grid-cell']);
});

describe('the rules the component tests lean on', () => {
  const base = FILES.find(f => f.name === 'base.css')!.css;
  const row = FILES.find(f => f.name.endsWith('TaskRow.css'))!.css;
  const tokens = FILES.find(f => f.name === TOKENS)!.css;

  it('makes .tabular mean tabular numerals', () => {
    // The other half of TaskRow's jitter test: jsdom will not compute
    // font-variant-numeric, so the class and its meaning are checked separately.
    expect(base).toMatch(/\.mono,\s*\ntime,\s*\n\.tabular\s*\{[^}]*font-variant-numeric:\s*tabular-nums/);
  });

  it('strikes through a completed title', () => {
    expect(row).toMatch(/\.row\[data-done\] \.row-title\s*\{[^}]*text-decoration:\s*line-through/);
  });

  it('finishes the completion gesture inside 200ms', () => {
    // 100ms for the ring, then 100ms for the check behind a 60ms delay.
    expect(row).toMatch(/transition:\s*stroke-dashoffset var\(--dur-quick\) var\(--ease\) 60ms/);
    expect(tokens).toMatch(/--dur-quick:\s*100ms/);
  });

  it('holds the row at 36px on a mouse and 44px on a finger', () => {
    expect(row).toMatch(/min-height:\s*var\(--row-h\)/);
    expect(tokens).toMatch(/--row-h:\s*36px/);
    expect(tokens).toMatch(/@media \(pointer: coarse\)\s*\{\s*:root\s*\{\s*--row-h:\s*44px/);
  });
});
