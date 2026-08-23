import type { SVGProps } from 'react';

/*
 * The interface glyphs. All 16x16, all `currentColor`, all decorative: every one
 * of them lives inside a control that carries its own accessible name, so a
 * second name here would be read out twice.
 *
 * The check is drawn with `pathLength="1"`, which lets the stroke animate from
 * `stroke-dashoffset: 1` to `0` without anyone measuring the path. Hard-coding a
 * dash length is how that animation breaks the next time the check is redrawn.
 */

type GlyphProps = Omit<SVGProps<SVGSVGElement>, 'viewBox' | 'width' | 'height'>;

function Glyph({ children, ...rest }: GlyphProps) {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false" {...rest}>
      {children}
    </svg>
  );
}

export function PlayGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <path d="M5.2 3.4 L12.4 8 L5.2 12.6 Z" fill="currentColor" />
    </Glyph>
  );
}

export function StopGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <rect x="4.4" y="4.4" width="7.2" height="7.2" rx="1.5" fill="currentColor" />
    </Glyph>
  );
}

export function ChevronGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <path
        d="M6 4 L10 8 L6 12"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Glyph>
  );
}

/** The completion control's ring and check, as one shape the CSS animates. */
export function CheckGlyph(props: GlyphProps) {
  return (
    <svg
      viewBox="0 0 20 20"
      width="18"
      height="18"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      <circle className="check-ring" cx="10" cy="10" r="7.4" />
      <path className="check-tick" d="M6.3 10.2 L8.8 12.7 L13.7 7.3" pathLength="1" />
    </svg>
  );
}
