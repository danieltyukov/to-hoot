import './Wordmark.css';

export interface WordmarkProps {
  className?: string;
}

/*
 * "to-hoot", with a small solid pupil in each of the two `o`s of "hoot".
 *
 * The two `o`s are already a pair of eyes on the page; the pupils only say so.
 * It is a detail that does nothing at a glance and rewards a second look, which
 * is the point of it: it is the reason the word looks drawn rather than typed.
 *
 * Built from real characters rather than a picture of them, so the word stays
 * selectable, searchable and readable by a screen reader as "to-hoot". The
 * pupils are empty `::after` content, so they add nothing to what is announced.
 */
export function Wordmark({ className }: WordmarkProps) {
  return (
    <span className={className === undefined ? 'wordmark' : `wordmark ${className}`}>
      to-h<i className="wordmark-eye">o</i>
      <i className="wordmark-eye">o</i>t
    </span>
  );
}
