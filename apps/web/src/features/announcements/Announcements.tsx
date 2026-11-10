import { AnnouncementBanner } from '@qm/ui';
import { useTranslation } from '../../lib/translation.tsx';
import { useSession } from '../auth/api.ts';
import { useActiveAnnouncements } from './api.ts';
import { useDismissedAnnouncements } from './dismissed.ts';

/** Active platform announcements for the signed-in user. Staff and admin layouts only. */
export function Announcements() {
  const { data: session } = useSession();
  const userId = session?.user.id;
  if (!userId) return null;
  // Keyed so a different user signing in on this browser starts from their own dismissals.
  return <AnnouncementList key={userId} userId={userId} />;
}

function AnnouncementList({ userId }: { userId: string }) {
  const { t } = useTranslation();
  const { data } = useActiveAnnouncements();
  const { dismissed, dismiss } = useDismissedAnnouncements(userId);
  const announcements = data ?? [];
  const activeIds = announcements.map((a) => a.id);
  const shown = announcements.filter((a) => a.severity !== 'info' || !dismissed.includes(a.id));
  if (shown.length === 0) return null;
  return (
    <div data-testid="announcements">
      {shown.map((a) => (
        <AnnouncementBanner
          key={a.id}
          severity={a.severity}
          label={t(`announcement.severity.${a.severity}`)}
          message={a.message}
          dismissLabel={t('announcement.dismiss')}
          onDismiss={() => dismiss(a.id, activeIds)}
        />
      ))}
    </div>
  );
}
