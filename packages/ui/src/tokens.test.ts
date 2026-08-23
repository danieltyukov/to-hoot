// @vitest-environment node
// This one reads files off disk rather than rendering anything, and vitest
// stubs CSS imports, so it opts out of jsdom to get a real `import.meta.url`.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { readNameTable } from './test/woff2.js';

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const readBinary = (rel: string): Buffer =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)));

// The stylesheet is the source of truth, so the test reads it rather than a
// duplicate table of the same hex values. A duplicate would agree with itself
// forever and tell us nothing about what ships.
const CSS = read('./tokens.css');
const NOTICES = ['sans', 'serif', 'mono'].map(d => read(`./fonts/${d}/OFL.txt`));

interface Rule {
  selector: string;
  decls: Record<string, string>;
}

/**
 * Leaf declaration blocks in source order, comments stripped.
 *
 * An array rather than a map keyed by selector: `:root` legitimately appears
 * more than once (the base palette, and the coarse-pointer override), and a map
 * would silently keep only the last one.
 */
function rules(css: string): Rule[] {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: Rule[] = [];
  for (const [, selector, body] of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const decls: Record<string, string> = {};
    for (const line of body!.split(';')) {
      const at = line.indexOf(':');
      if (at === -1) continue;
      decls[line.slice(0, at).trim()] = line.slice(at + 1).trim();
    }
    out.push({ selector: selector!.trim().replace(/\s+/g, ' '), decls });
  }
  return out;
}

const RULES = rules(CSS);
const first = (selector: string): Record<string, string> =>
  RULES.find(r => r.selector === selector)?.decls ?? {};

const LIGHT = first(':root');
const SYSTEM_DARK = first(":root:not([data-theme='light'])");
const EXPLICIT_DARK = first(":root[data-theme='dark']");

/** The light palette with the dark overrides folded in. */
const DARK: Record<string, string> = { ...LIGHT, ...EXPLICIT_DARK };

function channel(v: number): number {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function rgb(hex: string): [number, number, number] {
  const h = hex.trim().replace('#', '');
  const full = h.length === 3 ? [...h].map(c => c + c).join('') : h;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

function luminance(hex: string): number {
  const [r, g, b] = rgb(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Hue in degrees, 0 = red, 120 = green. */
function hue(hex: string): number {
  const [r, g, b] = rgb(hex).map(v => v / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return 0;
  const h =
    max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

const THEMES = [
  ['light', LIGHT],
  ['dark', DARK],
] as const;

/*
 * Each foreground token with the ratio it has to clear.
 *
 * Everything that can be set in type is at 4.5:1, including `faint`. An earlier
 * version of this file put `faint` at 3:1 on the grounds that it is only ever
 * incidental, which was wrong twice over: WCAG 1.4.11 excludes text explicitly,
 * so it never applied, and four of the five things `faint` colours are text
 * (the hour labels, the nav counts, the composer placeholder, the "/" between
 * the two day totals). Being small and secondary is what makes contrast matter
 * more, not less.
 *
 * `accent` is the one exception and is genuinely non-text: the current-time
 * rule, the active nav marker, the ring, the focus outline and the tracked
 * pills. Every one is a "user interface component" under 1.4.11 at 3:1, and
 * a test below asserts it is never used as a text colour. Anything that wants
 * accent-coloured words uses `accent-hover`, which clears 4.5:1 in both themes.
 */
const FOREGROUNDS: ReadonlyArray<readonly [token: string, min: number]> = [
  ['text', 4.5],
  ['muted', 4.5],
  ['faint', 4.5],
  ['success', 4.5],
  ['danger', 4.5],
  ['accent-hover', 4.5],
  ['accent', 3],
];

describe('tokens.css', () => {
  it('declares the whole light palette on bare :root', () => {
    for (const token of ['bg', 'surface', 'border', 'text', 'muted', 'faint', 'accent']) {
      expect(LIGHT[`--${token}`], token).toBeDefined();
    }
  });

  it('gives no colour its only definition inside a media query', () => {
    for (const key of Object.keys(SYSTEM_DARK)) {
      if (!key.startsWith('--')) continue;
      expect(LIGHT[key], `${key} is defined only under prefers-color-scheme`).toBeDefined();
    }
  });

  it('keeps the system-dark and explicit-dark blocks identical', () => {
    // They drift the moment someone edits one and forgets the other, and the
    // half that rots is the half their own machine does not render.
    expect(SYSTEM_DARK).toEqual(EXPLICIT_DARK);
  });

  it('guards the system-dark block so an explicit light choice still wins', () => {
    expect(CSS).toMatch(
      /@media \(prefers-color-scheme: dark\)\s*\{\s*:root:not\(\[data-theme='light'\]\)/,
    );
  });

  for (const [name, palette] of THEMES) {
    for (const [token, min] of FOREGROUNDS) {
      for (const ground of ['bg', 'surface'] as const) {
        it(`${name}: ${token} clears ${min}:1 on ${ground}`, () => {
          const fg = palette[`--${token}`]!;
          const bg = palette[`--${ground}`]!;
          expect(contrast(fg, bg)).toBeGreaterThanOrEqual(min);
        });
      }
    }

    it(`${name}: the accent is not in the green hue family`, () => {
      // Green is spoken for by the completed state. An accent that drifts into
      // it makes "running" and "done" the same colour.
      const h = hue(palette['--accent']!);
      expect(h < 60 || h > 180, `accent hue is ${h.toFixed(0)}deg`).toBe(true);
    });

    it(`${name}: success reads as green`, () => {
      const h = hue(palette['--success']!);
      expect(h).toBeGreaterThan(90);
      expect(h).toBeLessThan(180);
    });

    it(`${name}: borders are visible without being lines of text`, () => {
      // 3:1 is the non-text threshold. A hairline that fails it is decoration.
      expect(contrast(palette['--border-strong']!, palette['--bg']!)).toBeGreaterThanOrEqual(1.2);
      expect(contrast(palette['--text']!, palette['--border']!)).toBeGreaterThanOrEqual(4.5);
    });
  }

  it('keeps the accent hue across the theme flip', () => {
    // A warm-metal accent that has to darken to reach contrast on white arrives
    // as olive. Clay holds its identity at both lightnesses, and this checks it.
    expect(Math.abs(hue(LIGHT['--accent']!) - hue(DARK['--accent']!))).toBeLessThan(12);
  });

  it('exposes a radius token for every radius the design uses', () => {
    // One, not two: the panel radius has nothing to round yet, and a token
    // nothing consumes is a value no test can be wrong about. It comes back at
    // 10px with the first real panel; see the comment in tokens.css.
    expect(LIGHT['--r-control']).toBe('6px');
    const radiusTokens = Object.keys(LIGHT).filter(k => k.startsWith('--r-'));
    expect(radiusTokens).toEqual(['--r-control']);
  });

  it('carries the three motion durations and the one easing curve', () => {
    expect(LIGHT['--dur-quick']).toBe('100ms');
    expect(LIGHT['--dur-base']).toBe('200ms');
    expect(LIGHT['--dur-slow']).toBe('320ms');
    expect(LIGHT['--ease']).toBe('cubic-bezier(0.165, 0.84, 0.44, 1)');
  });

  it('honours prefers-reduced-motion', () => {
    expect(CSS).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    expect(CSS).toMatch(/transition-duration: 1ms !important/);
  });

  it('bases the type scale on 15px', () => {
    expect(LIGHT['--fs-base']).toBe('15px');
    expect(LIGHT['--fs-micro']).toBe('11px');
    expect(LIGHT['--fs-h1']).toBe('24px');
    expect(LIGHT['--ls-micro']).toBe('0.07em');
  });

  it('self-hosts all three families under their renamed OFL subsets', () => {
    for (const family of ['To-Hoot Sans', 'To-Hoot Serif', 'To-Hoot Mono']) {
      expect(CSS).toContain(`font-family: '${family}'`);
    }
    // Renamed because subsetting is a modification and the OFL reserves the
    // original names for unmodified files.
    expect(CSS).not.toMatch(/Instrument Sans|Newsreader|JetBrains Mono/);
    expect(CSS).not.toMatch(/fonts\.googleapis\.com|fonts\.gstatic\.com/);
  });

  it('ships every subset beside its unmodified OFL notice', () => {
    for (const notice of NOTICES) {
      expect(notice).toContain('SIL OPEN FONT LICENSE');
      // Every one of the three reserves its name, which is why the subsets are
      // renamed rather than shipped as the original families.
      expect(notice).toContain('Reserved Font Name');
    }
  });
});

/*
 * The licence check reads the shipped binaries, not the stylesheet.
 *
 * The stylesheet only proves what the CSS asks for. What the OFL constrains is
 * what is inside the file: nameID 1 is what a font manager shows, 18 is what
 * some systems show, 6 is what a PDF embeds, and an fvar instance carries its
 * own PostScript name that no walk of IDs 1 to 25 would reach. All four have
 * to be clean, and only reading the file can say whether they are.
 */
describe('the shipped font binaries', () => {
  const FONTS = [
    ['sans', 'To-Hoot Sans', 'Instrument Sans'],
    ['serif', 'To-Hoot Serif', 'Newsreader'],
    ['mono', 'To-Hoot Mono', 'JetBrains Mono'],
  ] as const;

  // Copyright, trademark and manufacturer. The OFL requires these to survive
  // unchanged: they are attribution, not the font's name, and stripping them
  // would remove the credit the licence exists to preserve.
  const ATTRIBUTION = new Set([0, 7, 8]);

  describe.each(FONTS)('%s', (dir, family, original) => {
    const records = readNameTable(readBinary(`./fonts/${dir}/tohoot-${dir}.woff2`));

    it('carries the reserved name in no record except attribution', () => {
      const leaks = records
        .filter(r => !ATTRIBUTION.has(r.nameID))
        .filter(r => r.text.includes(original) || r.text.includes(original.replace(/ /g, '')));
      expect(leaks.map(r => `${r.nameID}: ${r.text}`)).toEqual([]);
    });

    it('keeps the upstream attribution intact', () => {
      // The other half of the same licence term. A rename that also wiped the
      // copyright would pass the test above and still breach the OFL.
      const copyright = records.find(r => r.nameID === 0);
      expect(copyright?.text).toContain(original.split(' ')[0]);
    });

    it('renames every record a user or a system reads the family from', () => {
      for (const nid of [1, 4, 6, 16, 18, 21, 25]) {
        for (const record of records.filter(r => r.nameID === nid)) {
          expect(record.text.replace(/[- ]/g, ''), `nameID ${nid}`).toContain(
            family.replace(/[- ]/g, ''),
          );
        }
      }
    });

    it('renames the PostScript name of every named instance', () => {
      // These sit at nameIDs above 255 and are reached through fvar, not by
      // walking the well-known IDs. Missing them was a real leak.
      const instanceNames = records.filter(r => r.nameID >= 256 && r.text.includes('-'));
      for (const record of instanceNames) {
        expect(record.text).toContain(family.replace(/[- ]/g, ''));
      }
    });
  });
});
