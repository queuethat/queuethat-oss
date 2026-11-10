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
import { funnelQuery, STUCK_PAGE } from './api.ts';
import { barWidth, percent, STUCK_STAGES, type FunnelFilter, type StuckStage } from './funnel.ts';
import { formatWhen } from './format.ts';

/**
 * `/platform/funnel` (#1129): how many tenants created in a range reached each stage, and the
 * active ones stuck before their first served guest. The database owns the stages and the
 * "stuck" rule; this page renders them.
 */
export function FunnelPage({ filter }: { filter: FunnelFilter }) {
  const { t, i18n } = useTranslation('platform');
  const navigate = useNavigate();
  const funnel = useQuery(funnelQuery(filter));
  const page = filter.page ?? 0;
  const go = (next: FunnelFilter) =>
    void navigate({ to: '/platform/funnel', search: { ...filter, ...next } });

  if (funnel.isError) return <EmptyState title={t('ops.loadFailed')} />;
  if (!funnel.data) return <Spinner label={t('funnel.loading')} />;
  const { stages, stuck, stuck_total: total } = funnel.data;
  const number = new Intl.NumberFormat(i18n.language);
  const max = Math.max(0, ...stages.map((s) => s.count));
  const pages = Math.max(1, Math.ceil(total / STUCK_PAGE));

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('funnel.title')} />
      <form
        className="flex flex-wrap items-end gap-4"
        role="search"
        aria-label={t('funnel.range')}
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          const from = String(data.get('from') ?? '');
          const to = String(data.get('to') ?? '');
          // One field left empty means the default for that end; a reversed range is the user's slip.
          go({ from: from || undefined, to: to || undefined, page: undefined });
        }}
      >
        <Input
          key={`from-${funnel.data.from_date}`}
          label={t('funnel.from')}
          name="from"
          type="date"
          defaultValue={funnel.data.from_date}
        />
        <Input
          key={`to-${funnel.data.to_date}`}
          label={t('funnel.to')}
          name="to"
          type="date"
          defaultValue={funnel.data.to_date}
        />
        <Button type="submit">{t('funnel.apply')}</Button>
      </form>
      <p className="text-sm text-muted">
        {t('funnel.caption', { from: funnel.data.from_date, to: funnel.data.to_date })}
      </p>

      <ol className="flex flex-col gap-3" aria-label={t('funnel.stages')}>
        {stages.map((s, i) => (
          <li
            key={s.stage}
            data-testid="stage"
            data-stage={s.stage}
            className="flex flex-col gap-1"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="font-semibold">{t(`funnel.stage.${s.stage}`)}</span>
              <span>
                {number.format(s.count)}
                {i > 0 ? (
                  <span className="text-muted">
                    {' · '}
                    {t(i >= 7 ? 'funnel.ofSignups' : 'funnel.ofPrevious', {
                      percent: percent(s.conversion_prev, i18n.language),
                    })}
                  </span>
                ) : null}
              </span>
            </div>
            <div className="h-3 rounded bg-surface-sunken" aria-hidden="true">
              <div className="h-3 rounded bg-primary" style={{ width: barWidth(s.count, max) }} />
            </div>
          </li>
        ))}
      </ol>
      <p className="text-sm text-muted">
        {t('funnel.noBusiness', { count: funnel.data.signups_without_business })}
      </p>

      <section aria-labelledby="stuck-title" className="flex flex-col gap-3">
        <h2 id="stuck-title" className="text-xl font-semibold">
          {t('funnel.stuckTitle', { count: total })}
        </h2>
        <Select
          label={t('funnel.stageFilter')}
          name="stage"
          value={filter.stage ?? ''}
          onChange={(event) =>
            go({
              stage: (event.target.value || undefined) as StuckStage | undefined,
              page: undefined,
            })
          }
        >
          <option value="">{t('funnel.anyStage')}</option>
          {STUCK_STAGES.map((stage) => (
            <option key={stage} value={stage}>
              {t(`funnel.stage.${stage}`)}
            </option>
          ))}
        </Select>
        {stuck.length === 0 ? (
          <EmptyState title={t(total === 0 ? 'funnel.noneStuck' : 'funnel.pastEnd')} />
        ) : (
          <ScrollRegion label={t('funnel.stuckTitle', { count: total })}>
            <table className="w-full text-left">
              <thead className="text-sm text-muted">
                <tr>
                  <th className="py-2 pr-4">{t('directory.columns.name')}</th>
                  <th className="py-2 pr-4">{t('directory.columns.owner')}</th>
                  <th className="py-2 pr-4">{t('funnel.stoppedAt')}</th>
                  <th className="py-2 pr-4">{t('funnel.since')}</th>
                  <th className="py-2">{t('funnel.days')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {stuck.map((row) => (
                  <tr key={row.org_id} data-testid="stuck">
                    <td className="py-3 pr-4">
                      <Link
                        to="/platform/orgs/$orgId"
                        params={{ orgId: row.org_id }}
                        className="font-semibold underline"
                      >
                        {row.name}
                      </Link>
                    </td>
                    <td className="py-3 pr-4 break-all">{row.owner_email}</td>
                    <td className="py-3 pr-4">
                      <Badge tone="warning">{t(`funnel.stage.${row.stage}`)}</Badge>
                    </td>
                    <td className="py-3 pr-4">{formatWhen(row.reached_at, i18n.language, '')}</td>
                    <td className="py-3">{number.format(row.stuck_days)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollRegion>
        )}
        {pages > 1 ? (
          <nav className="flex items-center gap-4" aria-label={t('directory.pages')}>
            {page > 0 ? (
              <Link
                to="/platform/funnel"
                search={{ ...filter, page: page > 1 ? page - 1 : undefined }}
                className="underline"
              >
                {t('directory.previous')}
              </Link>
            ) : null}
            <span>{t('funnel.pageOf', { page: page + 1, pages })}</span>
            {page + 1 < pages ? (
              <Link
                to="/platform/funnel"
                search={{ ...filter, page: page + 1 }}
                className="underline"
              >
                {t('directory.next')}
              </Link>
            ) : null}
          </nav>
        ) : null}
      </section>
    </div>
  );
}
