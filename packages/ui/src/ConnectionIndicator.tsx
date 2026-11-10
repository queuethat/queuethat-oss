import { cx } from './cx.ts';

/** Mirrors what `useConnectionState()` (live data module) will report. */
export type ConnectionState = 'live' | 'connecting' | 'offline';

const styles: Record<ConnectionState, { pill: string; dot: string }> = {
  live: { pill: 'bg-success-soft text-success-strong', dot: 'bg-success-strong' },
  connecting: {
    pill: 'bg-warning-soft text-warning-strong',
    dot: 'bg-warning-strong motion-safe:animate-pulse',
  },
  offline: { pill: 'bg-danger-soft text-danger-strong', dot: 'bg-danger-strong' },
};

/** Tells staff and guests whether what they see is current. `label` is the t() text. */
export function ConnectionIndicator({ state, label }: { state: ConnectionState; label: string }) {
  return (
    <span
      role="status"
      data-state={state}
      className={cx(
        'inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm font-medium',
        styles[state].pill,
      )}
    >
      <span aria-hidden="true" className={cx('size-2.5 rounded-full', styles[state].dot)} />
      {label}
    </span>
  );
}
