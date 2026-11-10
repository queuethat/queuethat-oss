import { cx } from './cx.ts';

export interface SkeletonProps {
  /** Rows to draw. Default 3. */
  rows?: number;
  /** Accessible name for the loading region, already through t(). */
  label: string;
  className?: string;
}

/**
 * Placeholder rows in the layout of a list while it loads. The region is `aria-busy` and named;
 * the shimmer is off under reduced motion.
 */
export function Skeleton({ rows = 3, label, className }: SkeletonProps) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={label}
      className={cx('flex flex-col gap-3', className)}
    >
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3 rounded-card border border-border p-4">
          <span className="size-11 shrink-0 rounded-control bg-border motion-safe:animate-pulse" />
          <span className="flex flex-1 flex-col gap-2">
            <span className="h-3.5 w-1/2 rounded bg-border motion-safe:animate-pulse" />
            <span className="h-3 w-1/3 rounded bg-border motion-safe:animate-pulse" />
          </span>
        </div>
      ))}
    </div>
  );
}
