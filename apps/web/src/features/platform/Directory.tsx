import {
  Badge,
  Button,
  EmptyState,
  Input,
  PageHeader,
  ScrollRegion,
  Select,
  Spinner,
} from '@qm/ui';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useTranslation } from '../../lib/translation.tsx';
import { ActivationBadge } from './Activation.tsx';
import { AttentionQueue } from './attention/AttentionQueue.tsx';
import { BillingOverview } from './billing/BillingOverview.tsx';
import { activationQuery, ORGS_PAGE, orgsQuery, type OrgStatus } from './api.ts';
import { formatWhen, STATUS_TONE } from './format.ts';
import { TaggedTenants } from './notes/TaggedTenants.tsx';
import { pageLinks, type DirectorySearch } from './search.ts';

const STATUSES: OrgStatus[] = ['active', 'suspended', 'pending_deletion'];

/** The tenant directory: search, status filter and pages of 50 by id. */
export function Directory({ filter }: { filter: DirectorySearch }) {
  const { t, i18n } = useTranslation('platform');
  const navigate = useNavigate();
  const orgs = useQuery({ ...orgsQuery(filter), enabled: !filter.tag });
  // The badge is secondary: a failed or slow activation call leaves the cell empty, not the page.
  const activation = useQuery(activationQuery(orgs.data?.map((org) => org.id) ?? []));
  const last = orgs.data?.at(-1);
  const links = pageLinks(filter, orgs.data?.length === ORGS_PAGE ? last?.id : undefined);

  return (
    <section className="flex flex-col gap-6" aria-label={t('directory.title')}>
      <PageHeader title={t('directory.title')} />
      <AttentionQueue />
      <BillingOverview />
      <form
        className="flex flex-wrap items-end gap-4"
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          const q = String(data.get('q') ?? '').trim();
          const status = String(data.get('status') ?? '') as OrgStatus | '';
          const tag = String(data.get('tag') ?? '')
            .trim()
            .toLowerCase();
          void navigate({
            to: '/platform',
            search: {
              ...(q ? { q } : {}),
              ...(status ? { status } : {}),
              ...(tag ? { tag } : {}),
            },
          });
        }}
      >
        <Input
          label={t('directory.search')}
          hint={t('directory.searchHint')}
          name="q"
          type="search"
          defaultValue={filter.q ?? ''}
        />
        <Select
          label={t('directory.statusFilter')}
          name="status"
          defaultValue={filter.status ?? ''}
        >
          <option value="">{t('directory.anyStatus')}</option>
          {STATUSES.map((status) => (
            <option key={status} value={status}>
              {t(`status.${status}`)}
            </option>
          ))}
        </Select>
        <Input
          label={t('directory.tagFilter')}
          hint={t('directory.tagHint')}
          name="tag"
          defaultValue={filter.tag ?? ''}
        />
        <Button type="submit">{t('directory.submit')}</Button>
      </form>

      {filter.tag ? <TaggedTenants tag={filter.tag} /> : null}

      {filter.tag ? null : orgs.isError ? (
        <EmptyState title={t('ops.loadFailed')} />
      ) : !orgs.data ? (
        <Spinner label={t('directory.loading')} />
      ) : orgs.data.length === 0 ? (
        <EmptyState title={t('directory.empty')} />
      ) : (
        <ScrollRegion label={t('directory.title')}>
          <table className="w-full text-left">
            <thead className="text-sm text-muted">
              <tr>
                <th className="py-2 pr-4">{t('directory.columns.name')}</th>
                <th className="py-2 pr-4">{t('directory.columns.status')}</th>
                <th className="py-2 pr-4">{t('directory.columns.activation')}</th>
                <th className="py-2 pr-4">{t('directory.columns.owner')}</th>
                <th className="py-2 pr-4">{t('directory.columns.created')}</th>
                <th className="py-2 pr-4">{t('directory.columns.lastActivity')}</th>
                <th className="py-2 pr-4">{t('directory.columns.visits')}</th>
                <th className="py-2 pr-4">{t('directory.columns.notifications')}</th>
                <th className="py-2">{t('directory.columns.size')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {orgs.data.map((org) => (
                <tr key={org.id} data-testid="tenant">
                  <td className="py-3 pr-4">
                    <Link
                      to="/platform/orgs/$orgId"
                      params={{ orgId: org.id }}
                      className="font-semibold underline"
                    >
                      {org.name}
                    </Link>
                    {org.slug ? <div className="text-sm text-muted">{`/q/${org.slug}`}</div> : null}
                  </td>
                  <td className="py-3 pr-4">
                    <Badge tone={STATUS_TONE[org.status]}>{t(`status.${org.status}`)}</Badge>
                  </td>
                  <td className="py-3 pr-4">
                    <ActivationBadge activation={activation.data?.get(org.id)} />
                  </td>
                  <td className="py-3 pr-4 break-all">{org.owner_email}</td>
                  <td className="py-3 pr-4">{formatWhen(org.created_at, i18n.language, '')}</td>
                  <td className="py-3 pr-4">
                    {formatWhen(org.last_activity_at, i18n.language, t('directory.never'))}
                  </td>
                  <td className="py-3 pr-4">{org.visits_7d}</td>
                  <td className="py-3 pr-4">
                    {org.notifications_sent_7d} / {org.notifications_failed_7d}
                  </td>
                  <td className="py-3">
                    {org.members} / {org.locations}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollRegion>
      )}

      {filter.tag ? null : (
        <nav className="flex gap-4" aria-label={t('directory.pages')}>
          {links.previous ? (
            <Link
              to="/platform"
              search={{ q: filter.q, status: filter.status, ...links.previous }}
              className="underline"
            >
              {t('directory.previous')}
            </Link>
          ) : null}
          {filter.after ? (
            <Link
              to="/platform"
              search={{ q: filter.q, status: filter.status }}
              className="underline"
            >
              {t('directory.first')}
            </Link>
          ) : null}
          {links.next ? (
            <Link
              to="/platform"
              search={{ q: filter.q, status: filter.status, ...links.next }}
              className="underline"
            >
              {t('directory.next')}
            </Link>
          ) : null}
        </nav>
      )}
    </section>
  );
}
