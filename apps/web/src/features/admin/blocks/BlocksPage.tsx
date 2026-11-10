import { Badge, Button, EmptyState, PageHeader, Skeleton } from '@qm/ui';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from '../../../lib/translation.tsx';
import { useNow } from '../../../lib/now.ts';
import { useCurrentOrg } from '../../auth/current.ts';
import { membersQuery } from '../team/api.ts';
import { blocksQuery, useUnblock, type Block } from './api.ts';

const CAN_UNBLOCK = ['manager', 'admin', 'owner'];

/** Who is blocked and why, with a way to lift each block (2P-PRV6, #193). */
export function BlocksPage() {
  const { t } = useTranslation('admin-privacy');
  const org = useCurrentOrg();
  if (!org) return <Skeleton label={t('loading')} rows={2} />;
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 pb-8">
      <PageHeader title={t('blocks.title')} description={t('blocks.intro')} />
      <BlockList orgId={org.id} canUnblock={CAN_UNBLOCK.includes(org.role)} />
    </div>
  );
}

function BlockList({ orgId, canUnblock }: { orgId: string; canUnblock: boolean }) {
  const { t, i18n } = useTranslation('admin-privacy');
  const blocks = useQuery(blocksQuery(orgId));
  const members = useQuery(membersQuery(orgId));
  const unblock = useUnblock(orgId);
  const now = useNow(60_000);
  const names = new Map((members.data ?? []).map((m) => [m.userId, m.displayName ?? m.email]));
  const date = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium' });
  if (blocks.isPending) return <Skeleton label={t('loading')} rows={2} />;
  if (blocks.isError) return <p role="alert">{t('blocks.failed')}</p>;
  if (blocks.data.length === 0) return <EmptyState title={t('blocks.empty')} />;
  const expired = (b: Block) => !!b.expiresAt && Date.parse(b.expiresAt) <= now;
  return (
    <ul className="flex flex-col gap-3">
      {blocks.data.map((b) => (
        <li key={b.id} data-testid="block" className="flex flex-wrap items-center gap-3">
          <Badge>{t(`blocks.kind.${b.kind}`)}</Badge>
          <span className="min-w-0 flex-1">
            <span className="block font-medium">{b.reason}</span>
            <span className="block text-muted">
              {t('blocks.by', {
                name: (b.createdBy && names.get(b.createdBy)) || t('blocks.unknownPerson'),
                date: date.format(new Date(b.createdAt)),
              })}
              {' · '}
              {b.expiresAt
                ? t(expired(b) ? 'blocks.expired' : 'blocks.until', {
                    date: date.format(new Date(b.expiresAt)),
                  })
                : t('blocks.forever')}
            </span>
          </span>
          {canUnblock ? (
            <Button
              variant="secondary"
              aria-label={t('blocks.unblockFor', { reason: b.reason })}
              loading={unblock.isPending && unblock.variables === b.id}
              onClick={() => unblock.mutate(b.id)}
            >
              {t('blocks.unblock')}
            </Button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
