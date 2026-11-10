import { cx } from './cx.ts';

export interface MarkProps {
  /** Edge length in px (the mark is square). 16 is the smallest size it holds at. Default 28. */
  size?: number;
  /**
   * Accessible name, already through t(). Omit when the wordmark sits beside it: the mark is then
   * hidden from assistive tech. Pass it only when the mark stands alone (an avatar, an icon).
   */
  label?: string;
  className?: string;
}

/**
 * The QueueThat mark: a porcelain Q whose tail is a lagoon dot, the guest being called out of the
 * line. Drawn once on a 512 grid with fixed fills (ink, porcelain, lagoon), so it does not follow
 * the theme and carries its own contrast on light and dark grounds alike.
 *
 * Use it exactly as drawn: never recolour, outline or animate it, never put it on lagoon or
 * marigold, never stack the wordmark under it. Keep `public/favicon.svg` and the PWA icons in step
 * with this drawing.
 */
export function Mark({ size = 28, label, className }: MarkProps) {
  return (
    <svg
      viewBox="0 0 512 512"
      width={size}
      height={size}
      focusable="false"
      className={cx('shrink-0', className)}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <rect width="512" height="512" rx="112" fill="#15171C" />
      <circle cx="250" cy="250" r="120" fill="none" stroke="#F6F6F2" strokeWidth="64" />
      <circle cx="357.5" cy="357.5" r="74" fill="#15171C" />
      <circle cx="357.5" cy="357.5" r="56" fill="#5FC4B2" />
    </svg>
  );
}
