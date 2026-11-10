import {
  EmptyState,
  iconCalendar,
  iconChart,
  iconClock,
  iconList,
  iconMonitor,
  iconPlug,
  iconUsers,
  type IconDef,
} from '@qm/ui';
import type { ReactNode } from 'react';
import { useTranslation } from '../lib/translation.tsx';

/** The screens that show an empty state, each with its own icon and copy (`empty` namespace). */
export type EmptyKind =
  | 'console'
  | 'queues'
  | 'counters'
  | 'team'
  | 'devices'
  | 'guests'
  | 'analytics'
  | 'feedback'
  | 'developers';

const ICONS: Record<EmptyKind, IconDef> = {
  console: iconUsers,
  queues: iconList,
  counters: iconClock,
  team: iconUsers,
  devices: iconMonitor,
  guests: iconUsers,
  analytics: iconChart,
  feedback: iconCalendar,
  developers: iconPlug,
};

/**
 * What an empty first-run screen says: an icon, a short title, one sentence on why it is empty
 * and at most one primary and one secondary action. Copy lives in one place (`empty.json`) so
 * the screens read alike.
 */
export function ScreenEmpty({
  kind,
  action,
  secondary,
}: {
  kind: EmptyKind;
  action?: ReactNode;
  secondary?: ReactNode;
}) {
  const { t } = useTranslation('empty');
  return (
    <EmptyState
      icon={ICONS[kind]}
      title={t(`${kind}.title`)}
      description={t(`${kind}.why`)}
      action={action}
      secondary={secondary}
    />
  );
}
