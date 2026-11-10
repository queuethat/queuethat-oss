import { Badge, Card, ConfirmDestructive, EmptyState, Spinner, useToast } from '@qm/ui';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useTranslation } from '../../../lib/translation.tsx';
import { guestQuery, maskContact } from '../../admin/guests/api.ts';
import { useCurrentOrg } from '../../auth/current.ts';
import { guestTagsQuery } from '../tags/api.ts';
import { duplicatesQuery, useMergeGuests, type DuplicatePair } from './api.ts';

/** Admins review suggested duplicate guests and merge them (2B-C4, #303). */
export function DuplicatesPage() {
  const { t } = useTranslation('crm');
  const org = useCurrentOrg();
  const pairs = useQuery({ ...duplicatesQuery(org?.id ?? ''), enabled: !!org });
  const canMerge = org?.role === 'owner' || org?.role === 'admin';
  return (
    <Card className="mx-auto mt-8 flex max-w-4xl flex-col gap-6">
      <Link to="/admin/guests" className="inline-flex min-h-target items-center underline">
        {t('merge.back')}
      </Link>
      <h1 className="text-2xl font-semibold">{t('merge.title')}</h1>
      <p className="text-muted">{t('merge.intro')}</p>
      {pairs.isPending ? (
        <Spinner label={t('merge.loading')} />
      ) : pairs.isError ? (
        <p role="alert" className="font-medium text-danger-strong">
          {t('merge.failed')}
        </p>
      ) : pairs.data.length === 0 ? (
        <EmptyState title={t('merge.empty')} />
      ) : (
        <ul className="flex flex-col gap-4">
          {pairs.data.map((p) => (
            <PairCard key={`${p.keepId}:${p.mergeId}`} pair={p} canMerge={canMerge} />
          ))}
        </ul>
      )}
    </Card>
  );
}

function PairCard({ pair, canMerge }: { pair: DuplicatePair; canMerge: boolean }) {
  const { t } = useTranslation('crm');
  const merge = useMergeGuests();
  const toast = useToast();
  const a = useQuery(guestQuery(pair.keepId));
  const b = useQuery(guestQuery(pair.mergeId));
  const nameOf = (g?: { name: string | null }) => g?.name || t('merge.noName');
  const run = (keepId: string, mergeId: string) =>
    merge
      .mutateAsync({ keepId, mergeId })
      .then(() => toast.show({ message: t('merge.done'), tone: 'success' }))
      .catch(() => toast.show({ message: t('merge.error'), tone: 'danger' }));
  return (
    <li
      data-testid="duplicate-pair"
      className="flex flex-col gap-3 rounded-control border border-border p-4"
    >
      <p>
        <Badge tone="info">
          {t(`merge.reason.${pair.reason === 'same_email' ? 'email' : 'phone'}`)}
        </Badge>
      </p>
      <div className="grid gap-4 md:grid-cols-2">
        <Side
          guestId={pair.keepId}
          name={nameOf(a.data)}
          other={nameOf(b.data)}
          profile={a.data}
          canMerge={canMerge}
          onMerge={() => run(pair.keepId, pair.mergeId)}
        />
        <Side
          guestId={pair.mergeId}
          name={nameOf(b.data)}
          other={nameOf(a.data)}
          profile={b.data}
          canMerge={canMerge}
          onMerge={() => run(pair.mergeId, pair.keepId)}
        />
      </div>
    </li>
  );
}

function Side({
  guestId,
  name,
  other,
  profile,
  canMerge,
  onMerge,
}: {
  guestId: string;
  name: string;
  other: string;
  profile?: {
    contacts: { id: string; kind: 'phone' | 'email'; value: string }[];
    visitCount: number;
  };
  canMerge: boolean;
  onMerge: () => Promise<unknown>;
}) {
  const { t } = useTranslation('crm');
  const tags = useQuery(guestTagsQuery(guestId));
  return (
    <section aria-label={name} data-testid="duplicate-side" className="flex flex-col gap-2">
      <h2 className="text-lg font-semibold">{name}</h2>
      <p>{t('merge.visits', { count: profile?.visitCount ?? 0 })}</p>
      <ul>
        {profile?.contacts.map((c) => (
          <li key={c.id} className="font-mono">
            {maskContact(c.kind, c.value)}
          </li>
        ))}
      </ul>
      <p>{tags.data?.length ? tags.data.map((x) => x.name).join(', ') : t('merge.noTags')}</p>
      {canMerge ? (
        <ConfirmDestructive
          triggerLabel={t('merge.keep')}
          triggerAriaLabel={t('merge.keepFor', { name })}
          triggerVariant="secondary"
          title={t('merge.confirmTitle', { name })}
          description={t('merge.confirmDescription', { name, other })}
          confirmLabel={t('merge.confirm')}
          cancelLabel={t('merge.cancel')}
          onConfirm={onMerge}
        />
      ) : null}
    </section>
  );
}
