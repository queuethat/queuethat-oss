import { cx } from './cx.ts';

/** Indeterminate progress. `label` is announced to screen readers; pass it through t(). */
export function Spinner({ label, className }: { label: string; className?: string }) {
  return (
    <span role="status" className={cx('inline-flex items-center', className)}>
      <span
        aria-hidden="true"
        className="size-5 rounded-full border-2 border-current border-r-transparent motion-safe:animate-spin"
      />
      <span className="sr-only">{label}</span>
    </span>
  );
}
