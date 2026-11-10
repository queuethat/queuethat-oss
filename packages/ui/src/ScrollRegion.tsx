import type { ReactNode } from 'react';
import { cx } from './cx.ts';

/**
 * A horizontally scrolling wrapper for wide tables and code. A scrollable area has to be reachable
 * by keyboard (axe `scrollable-region-focusable`), so it is a focusable, named region. `label` names
 * it for screen readers; pass it through t().
 */
export function ScrollRegion({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      role="region"
      aria-label={label}
      // A scroll container must take focus so keyboard users can scroll it.
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={0}
      className={cx('overflow-x-auto focus-visible:outline-2', className)}
    >
      {children}
    </div>
  );
}
