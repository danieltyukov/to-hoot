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
/**
 * The eyes and the beak: everything after the disc, which is the first
 * subpath. The disc is what the small marks cut the face out of; the launcher
 * and the desktop icon paint the same face on a ground instead, so the face is
 * the part all four have to agree on.
 */
const FACE = ICON.slice(ICON.indexOf('Z') + 1).trim();

const FAVICON = read('../../public/favicon.svg');
const LAUNCHER = read('../../../../apps/mobile/icon-source.svg');
const DESKTOP = read('../../../../apps/desktop/icon-source.svg');
const ADAPTIVE = read(
  '../../../../apps/mobile/android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml',
);
const FOREGROUND = read(
  '../../../../apps/mobile/android/app/src/main/res/drawable/ic_launcher_foreground.xml',
);
const TOKENS = read('../tokens.css');

describe('the shipped marks', () => {
  it('cuts the favicon from the same geometry as the component', () => {
    // Two copies of one shape is the price of the favicon being a static file.
    // The copies drifting apart is the failure this catches: a component
    // nobody sees next to an icon everybody does.
    expect(pathData(FAVICON)).toBe(ICON);
  });

  it('draws the same eyes and beak on the launcher, the desktop icon and the adaptive layer', () => {
    // Four files carry the face. The script that writes three of them holds the
    // path once; this is what notices somebody editing one of them by hand.
    expect(FACE).not.toBe('');
    expect(pathData(LAUNCHER)).toBe(FACE);
    expect(pathData(DESKTOP)).toBe(FACE);
    const vector = /android:pathData="([^"]+)"/.exec(FOREGROUND)?.[1];
    expect(vector?.replace(/\s+/g, ' ').trim()).toBe(FACE);
  });

  it('punches the favicon out rather than painting it over', () => {
    // A hole shows the browser chrome through it. A painted shape shows
    // whatever colour it was authored in, on every ground.
    expect(FAVICON).toContain('fill-rule="evenodd"');
  });

  it('paints the launcher in the light accent, which is a token and not a guess', () => {
    const accent = /--accent:\s*(#[0-9a-f]{6});/i.exec(TOKENS)?.[1];
    expect(accent).toBeDefined();
    expect(LAUNCHER).toContain(`fill="${accent}"`);
    expect(DESKTOP).toContain(`fill="${accent}"`);
  });

  it('keeps the launcher face inside the adaptive-icon safe zone', () => {
    // Android crops to a circle, a squircle or a rounded square depending on
    // the launcher. Only a circle of 66% of the canvas survives all of them,
    // so every corner of the face's box has to sit inside that circle.
    const [, tx, ty, scale] = /translate\(([\d.-]+) ([\d.-]+)\) scale\(([\d.]+)\)/.exec(LAUNCHER)!;
    const s = Number(scale);
    // The face's box on the 32-unit grid: eyes from x 7.6 to 24.4, brow at
    // y 12.1, beak tip at y 24.6.
    const corners = [
      [7.6, 12.1],
      [24.4, 12.1],
      [7.6, 24.6],
      [24.4, 24.6],
    ];
    const radius = 1024 * 0.33;
    for (const [x, y] of corners) {
      const px = Number(tx) + x! * s - 512;
      const py = Number(ty) + y! * s - 512;
      expect(Math.hypot(px, py), `corner ${x},${y}`).toBeLessThan(radius);
    }
  });

  it('gives the adaptive icon a monochrome layer for themed launchers', () => {
    // Without it Android 13 shows a generic tinted tile with nothing of the
    // mark in it, which is the icon the owner said did not look good.
    expect(ADAPTIVE).toContain('<monochrome');
    expect(ADAPTIVE).toContain('@drawable/ic_launcher_foreground');
  });

  it('gives the favicon a fill in both themes', () => {
    // Browser chrome is light or dark and the tab icon does not get to choose.
    expect(FAVICON).toMatch(/@media \(prefers-color-scheme: dark\)/);
    expect(FAVICON).toContain('#c2603f');
    expect(FAVICON).toContain('#d97757');
  });
});
