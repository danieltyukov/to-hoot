// @vitest-environment node
// Reads the shipped asset files rather than rendering, so it opts out of jsdom.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

/** The `d` of the first path in a file, whitespace collapsed. */
function pathData(source: string): string {
  const d = /\sd="([^"]+)"/.exec(source)?.[1];
  expect(d, 'no path data found').toBeDefined();
  return d!.replace(/\s+/g, ' ').trim();
}

const ICON = pathData(read('./OwlIcon.tsx'));
const FAVICON = read('../../public/favicon.svg');
const APP_ICON = read('../../../../apps/mobile/icon-source.svg');

describe('the shipped marks', () => {
  it('cuts the favicon from the same geometry as the component', () => {
    // Three copies of one shape is the price of the favicon and the launcher
    // icon being static files. The copies drifting apart is the failure this
    // catches: a component nobody sees next to an icon everybody does.
    expect(pathData(FAVICON)).toBe(ICON);
  });

  it('cuts the launcher icon from the same geometry as the component', () => {
    expect(pathData(APP_ICON)).toBe(ICON);
  });

  it('punches the eyes and beak out rather than painting them over', () => {
    // A hole shows the launcher wallpaper or the browser chrome through it. A
    // painted shape shows whatever colour it was authored in, on every ground.
    expect(FAVICON).toContain('fill-rule="evenodd"');
    expect(APP_ICON).toContain('fill-rule="evenodd"');
  });

  it('keeps the launcher artwork inside the adaptive-icon safe zone', () => {
    // Android crops to a circle, a squircle or a rounded square depending on
    // the launcher. Only the central 66% survives all of them.
    const [, tx, scale] = /translate\(([\d.]+) [\d.]+\) scale\(([\d.]+)\)/.exec(APP_ICON)!;
    const diameter = 27.2 * Number(scale);
    const centre = Number(tx) + 16 * Number(scale);
    expect(diameter / 1024).toBeLessThanOrEqual(0.66);
    expect(centre).toBeCloseTo(512, 0);
  });

  it('gives the favicon a fill in both themes', () => {
    // Browser chrome is light or dark and the tab icon does not get to choose.
    expect(FAVICON).toMatch(/@media \(prefers-color-scheme: dark\)/);
    expect(FAVICON).toContain('#c2603f');
    expect(FAVICON).toContain('#d97757');
  });
});
