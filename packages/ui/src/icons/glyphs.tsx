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

/*
 * The window controls, for the desktop shell that draws no native title bar.
 * Drawn to the same 16px grid and the same 1.2 to 1.6 stroke as the rest, so
 * they read as part of the interface rather than as a widget borrowed from
 * whichever toolkit the window happens to be in.
 */

export function MinimizeGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <path d="M4 10.5 H12" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </Glyph>
  );
}

export function MaximizeGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <rect x="4" y="4" width="8" height="8" rx="1" fill="none" stroke="currentColor" strokeWidth="1.3" />
    </Glyph>
  );
}

/** Two offset frames: the window is maximised and this puts it back. */
export function RestoreGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <path
        d="M6.5 5.5 V4.5 A1 1 0 0 1 7.5 3.5 H11.5 A1 1 0 0 1 12.5 4.5 V8.5 A1 1 0 0 1 11.5 9.5 H10.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
      <rect x="3.5" y="6.5" width="7" height="6" rx="1" fill="none" stroke="currentColor" strokeWidth="1.3" />
    </Glyph>
  );
}

export function CloseGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <path
        d="M4.5 4.5 L11.5 11.5 M11.5 4.5 L4.5 11.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </Glyph>
  );
}
