import { StatusPill, Tabs } from '@qm/ui';
import { useQueries } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useTranslation } from '../../lib/translation.tsx';
import { POLL_MS } from '../../lib/live.ts';
import { groupMembers, type useVisitStatus } from './api.ts';
import { guestRpc } from './client.ts';

type Visit = NonNullable<ReturnType<typeof useVisitStatus>['data']>;

/**
 * One tab per person when several joined together (2A-J15B), each with that person's live
 * status. Tabs are only links between status pages: every page still shows one visit.
 */
export function GroupTabs({
  token,
  current,
  panelId,
}: {
  token: string;
  current: Visit;
  panelId: string;
}) {
  const { t } = useTranslation('guest');
  const navigate = useNavigate();
  const members = groupMembers(token);
  const others = useQueries({
    queries: members
      .filter((m) => m.token !== token)
      .map((m) => ({
        queryKey: ['guest', 'visit', m.token],
        queryFn: () => guestRpc('get_visit_status', { p_token: m.token }),
        refetchInterval: POLL_MS,
        retry: false,
      })),
  });
  let next = 0;
  const items = members.map((m) => {
    const visit = m.token === token ? current : others[next++]?.data;
    return {
      id: m.token,
      label: visit?.display_ticket
        ? t('status.group.tab', { name: m.name, ticket: visit.display_ticket })
        : m.name,
      extra: visit?.status ? (
        <StatusPill status={visit.status}>{t(`status.state.${visit.status}`)}</StatusPill>
      ) : null,
    };
  });
  return (
    <Tabs
      label={t('status.group.label')}
      items={items}
      value={token}
      panelId={panelId}
      onChange={(next) => void navigate({ to: '/v/$token', params: { token: next } })}
    />
  );
}
