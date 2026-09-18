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

/*
 * Navigation and status glyphs, added with the 0.6.0 refresh. Same grid, same
 * strokes, same rule about names: the control around each one says what it is.
 */

/** Today: a sun low over a line, which is a day rather than a calendar page. */
export function TodayGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <circle cx="8" cy="7.5" r="3" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M3 12.5 H13 M8 2 V3 M2.8 4.3 L3.6 5 M13.2 4.3 L12.4 5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </Glyph>
  );
}

/** A project: a stack of rows, which is what a project is in this app. */
export function ProjectGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <path
        d="M3.5 4.5 H12.5 M3.5 8 H12.5 M3.5 11.5 H9.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </Glyph>
  );
}

/** A tag, with its hole. */
export function TagGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <path
        d="M3 3.5 H8.2 L13 8.3 L8.3 13 L3.5 8.2 V3.5 Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <circle cx="6" cy="6" r="1" fill="currentColor" />
    </Glyph>
  );
}

export function GearGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <circle cx="8" cy="8" r="2.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M8 2.2 V3.6 M8 12.4 V13.8 M2.2 8 H3.6 M12.4 8 H13.8 M3.9 3.9 L4.9 4.9 M11.1 11.1 L12.1 12.1 M12.1 3.9 L11.1 4.9 M4.9 11.1 L3.9 12.1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </Glyph>
  );
}

/** The phone's three tabs. Lists is the sidebar, Tasks the list, Day the timeline. */
export function ListsGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <path
        d="M3 4 H4.5 M6.5 4 H13 M3 8 H4.5 M6.5 8 H13 M3 12 H4.5 M6.5 12 H13"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </Glyph>
  );
}

export function TasksGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <circle cx="8" cy="8" r="5.6" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M5.4 8.2 L7.3 10.1 L10.8 6.3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Glyph>
  );
}

export function DayGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <circle cx="8" cy="8" r="5.6" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M8 4.8 V8.2 L10.4 9.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Glyph>
  );
}

export function PlusGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <path
        d="M8 3.5 V12.5 M3.5 8 H12.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </Glyph>
  );
}

/*
 * The three connections in Settings. A cloud for sync (the data lives in a
 * repository somewhere else), a calendar page, and a spark for Claude.
 */
export function SyncGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <path
        d="M4.6 12.5 H11.6 A2.6 2.6 0 0 0 11.9 7.3 A3.6 3.6 0 0 0 4.9 6.6 A3 3 0 0 0 4.6 12.5 Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </Glyph>
  );
}

export function CalendarGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <rect x="2.75" y="3.75" width="10.5" height="9.5" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M2.75 6.75 H13.25 M5.5 2.5 V4.5 M10.5 2.5 V4.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </Glyph>
  );
}

export function SparkGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <path
        d="M8 2.5 C8.4 5.6 10.4 7.6 13.5 8 C10.4 8.4 8.4 10.4 8 13.5 C7.6 10.4 5.6 8.4 2.5 8 C5.6 7.6 7.6 5.6 8 2.5 Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </Glyph>
  );
}

/** A device row in Settings: a phone or a desktop, by the shell's kind. */
export function PhoneGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <rect x="4.75" y="2.25" width="6.5" height="11.5" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M7 11.5 H9" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </Glyph>
  );
}

export function DesktopGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <rect x="2.25" y="3.25" width="11.5" height="7.5" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M6 13 H10 M8 10.75 V13" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </Glyph>
  );
}

/** Anything else that writes to the repository: a Worker, a server, a browser. */
export function CloudDeviceGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <rect x="2.25" y="4.25" width="11.5" height="3" rx="1" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <rect x="2.25" y="8.75" width="11.5" height="3" rx="1" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M4.5 5.75 H5 M4.5 10.25 H5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </Glyph>
  );
}
