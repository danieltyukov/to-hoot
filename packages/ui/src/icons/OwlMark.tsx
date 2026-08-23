import type { SVGProps } from 'react';

export interface OwlMarkProps extends Omit<SVGProps<SVGSVGElement>, 'width' | 'height'> {
  size?: number;
  /**
   * Pass null where the mark sits beside the word "to-hoot" already: two
   * accessible names for one thing makes a screen reader say it twice.
   */
  label?: string | null;
}

/*
 * The logo: an open "heart brow".
 *
 * One stroke draws two arches over the eyes and then descends into open sides,
 * so a facial disc is implied without ever being closed. Closing it was tried
 * and rejected: an interior disc reads as a pair of headphones.
 *
 * The two arches are exact semicircles (each chord is 11.5, each radius 5.75),
 * which is what keeps the brow from looking hand-drawn at small sizes. Ear tufts
 * are deliberately absent; pointed tufts read as a cat.
 *
 * This mark fills in below roughly 20px, where the 2.1 stroke and the gaps
 * around the eyes collapse into a blob. Use OwlIcon there.
 */
export function OwlMark({ size = 32, label = 'to-hoot', ...rest }: OwlMarkProps) {
  const a11y =
    label === null ? { 'aria-hidden': true as const } : { role: 'img', 'aria-label': label };
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} {...a11y} {...rest}>
      <path
        d="M4.5,22 V15.5 A5.75,5.75 0 0,1 16,15.5 A5.75,5.75 0 0,1 27.5,15.5 V22"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.1"
        strokeLinecap="round"
      />
      <circle cx="10.25" cy="17" r="2.8" fill="currentColor" />
      <circle cx="21.75" cy="17" r="2.8" fill="currentColor" />
      <path d="M14.1,16.6 L17.9,16.6 L16,21 Z" fill="currentColor" />
    </svg>
  );
}
