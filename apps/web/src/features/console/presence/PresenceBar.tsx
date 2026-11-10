import { Badge, Select, useToast, type Tone } from '@qm/ui';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from '../../../lib/translation.tsx';
import { useNow } from '../../../lib/now.ts';
import { membersQuery } from '../../admin/team/api.ts';
import { useSession } from '../../auth/api.ts';
import { useCurrentOrg } from '../../auth/current.ts';
import { useSetPresence, useTeamPresence, type PresenceStatus } from './api.ts';

const STATUSES: PresenceStatus[] = ['available', 'break', 'away'];
const TONES: Record<PresenceStatus, Tone> = {
  available: 'success',
  break: 'warning',
  away: 'neutral',
};

/** The signed-in user's own status at the location, or undefined until they report one. */
export function useMyPresence(locationId: string | undefined) {
  const userId = useSession().data?.user.id;
  const team = useTeamPresence(locationId);
  return team.data?.find((p) => p.userId === userId);
}

function minutesSince(iso: string, now: number) {
  return Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000));
}

/**
 * S-15 (#272): one control to be available, on break or away, and a strip of who is working. The
 * state is text and colour; the break timer counts from when the break began. The ETA follows
 * the database's rule over these statuses.
 */
export function PresenceBar({
  locationId,
  counterId,
  counterLabels,
}: {
  locationId: string;
  counterId: string | null;
  counterLabels: Map<string, string>;
}) {
  const { t } = useTranslation('staff');
  const toast = useToast();
  const now = useNow(30_000);
  const org = useCurrentOrg();
  const userId = useSession().data?.user.id;
  const team = useTeamPresence(locationId);
  const members = useQuery({ ...membersQuery(org?.id ?? ''), enabled: !!org });
  const set = useSetPresence(locationId);
  const mine = team.data?.find((p) => p.userId === userId);
  const nameOf = (id: string) =>
    members.data?.find((m) => m.userId === id)?.displayName || t('presence.someone');

  return (
    <div className="flex flex-wrap items-end gap-4" data-testid="presence-bar">
      <div className="w-56">
        <Select
          label={t('presence.label')}
          value={mine?.status ?? ''}
          onChange={(event) =>
            set.mutate(
              { status: event.target.value as PresenceStatus, counterId },
              { onError: () => toast.show({ tone: 'danger', message: t('presence.failed') }) },
            )
          }
        >
          {mine ? null : (
            <option value="" disabled>
              {t('presence.unset')}
            </option>
          )}
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {t(`presence.status.${s}`)}
            </option>
          ))}
        </Select>
      </div>
      {mine?.status === 'break' && (
        <p data-testid="break-timer">
          {t('presence.breakFor', { count: minutesSince(mine.since, now) })}
        </p>
      )}
      <ul className="flex flex-wrap gap-2" aria-label={t('presence.team')} data-testid="team-strip">
        {(team.data ?? []).map((p) => (
          <li key={p.userId} className="flex items-center gap-2">
            <span>{nameOf(p.userId)}</span>
            <Badge tone={TONES[p.status]}>{t(`presence.status.${p.status}`)}</Badge>
            {p.counterId && counterLabels.get(p.counterId) ? (
              <span className="text-sm text-muted">{counterLabels.get(p.counterId)}</span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
