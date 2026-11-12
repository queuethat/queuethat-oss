import { Select } from '@qm/ui';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from '../../../../lib/translation.tsx';
import { membersQuery } from '../../team/api.ts';
import { lineOwnersQuery, useSetLineOwner } from './api.ts';

/**
 * "Whose line is this?" on a queue card (#1388). A provider line's bookings are offered and assigned
 * to that person only; "Anyone" keeps today's behaviour. Pools ("Anyone available") have no person.
 */
export function LineOwner({
  orgId,
  locationId,
  queueId,
}: {
  orgId: string;
  locationId: string;
  queueId: string;
}) {
  const { t } = useTranslation('admin');
  const owners = useQuery(lineOwnersQuery(locationId));
  const members = useQuery(membersQuery(orgId));
  const save = useSetLineOwner(locationId);
  const line = owners.data?.[queueId];
  if (!line || line.kind === 'pool' || !members.data) return null;
  const here = members.data.filter(
    (m) => m.userId && (m.locationIds === null || m.locationIds.includes(locationId)),
  );
  return (
    <div className="flex flex-col gap-1">
      <Select
        label={t('queues.provider.label')}
        hint={t('queues.provider.hint')}
        value={line.providerUserId ?? ''}
        disabled={save.isPending}
        onChange={(event) => save.mutate({ queueId, userId: event.target.value || null })}
      >
        <option value="">{t('queues.provider.anyone')}</option>
        {here.map((m) => (
          <option key={m.id} value={m.userId ?? ''}>
            {m.displayName ?? m.email ?? t('queues.provider.unnamed')}
          </option>
        ))}
      </Select>
      <p role="alert" className="font-medium text-danger-strong empty:hidden">
        {save.error ? t('queues.provider.failed') : null}
      </p>
    </div>
  );
}
