import type { SVGProps } from 'react';

export interface OwlIconProps extends Omit<SVGProps<SVGSVGElement>, 'width' | 'height'> {
  size?: number;
  /** Null marks it decorative; see OwlMark. */
  label?: string | null;
}

/*
 * The app icon: the same two eyes and beak triangle as OwlMark, cut out of a
 * solid disc instead of drawn on top of one.
 *
 * One path with `fill-rule: evenodd`, not four shapes stacked, because the
 * cut-outs have to be genuinely transparent: the icon sits on a launcher
 * wallpaper, a browser tab and a system tray, and a hole painted in a background
 * colour is a rectangle of the wrong colour on all three.
 *
 * Negative space is what keeps it legible at 16px. There is no stroke to thin
 * out and no gap to close, so the shape degrades into a disc with three marks
 * rather than into a blob.
 */
export function OwlIcon({ size = 32, label = 'to-hoot', ...rest }: OwlIconProps) {
  const a11y =
    label === null ? { 'aria-hidden': true as const } : { role: 'img', 'aria-label': label };
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} {...a11y} {...rest}>
      <path
        fillRule="evenodd"
        d="M2.4,16 a13.6,13.6 0 1,0 27.2,0 a13.6,13.6 0 1,0 -27.2,0 Z
           M7.6,15.6 a3.5,3.5 0 1,0 7,0 a3.5,3.5 0 1,0 -7,0 Z
           M17.4,15.6 a3.5,3.5 0 1,0 7,0 a3.5,3.5 0 1,0 -7,0 Z
           M13.7,20 L18.3,20 L16,24.6 Z"
        fill="currentColor"
      />
    </svg>
  );
}
