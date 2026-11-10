import type { Database } from '@qm/db-types';
import { Button } from './Button.tsx';
import { cx } from './cx.ts';

/** Platform announcement severities, owned by the database (PLT9, #415). */
export type AnnouncementSeverity = Database['app']['Enums']['announcement_severity'];

const tones: Record<AnnouncementSeverity, string> = {
  info: 'bg-info-soft text-info-strong',
  warning: 'bg-warning-soft text-warning-strong',
  maintenance: 'bg-danger-soft text-danger-strong',
};

export interface AnnouncementBannerProps {
  severity: AnnouncementSeverity;
  /** The t() name of the severity, shown before the message so colour is never the only signal. */
  label: string;
  /** The operator's text, shown as written. */
  message: string;
  dismissLabel: string;
  /** Only `info` announcements can be dismissed; for the others this is ignored. */
  onDismiss?: () => void;
}

/**
 * A platform-wide notice across the top of staff pages. Warning and maintenance notices can't be
 * dismissed, so nobody misses planned downtime; remembering a dismissal is the caller's job.
 */
export function AnnouncementBanner({
  severity,
  label,
  message,
  dismissLabel,
  onDismiss,
}: AnnouncementBannerProps) {
  const dismissible = severity === 'info' && onDismiss !== undefined;
  return (
    <div
      role="status"
      data-severity={severity}
      className={cx('flex items-center gap-3 px-6 py-2', tones[severity])}
    >
      <p className="flex-1">
        <strong className="font-semibold">{label}: </strong>
        {message}
      </p>
      {dismissible ? (
        <Button variant="secondary" onClick={onDismiss}>
          {dismissLabel}
        </Button>
      ) : null}
    </div>
  );
}
