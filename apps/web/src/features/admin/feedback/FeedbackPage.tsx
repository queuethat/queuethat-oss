import { BarChart, Button, Input, PageHeader, ScrollRegion, Skeleton } from '@qm/ui';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslation } from '../../../lib/translation.tsx';
import { ScreenEmpty } from '../../../components/ScreenEmpty.tsx';
import { useNoVisitsYet } from '../dashboard/setup/api.ts';
import { useCurrentLocation } from '../../auth/current.ts';
import { isoDay } from '../analytics/csv.ts';
import { feedbackCommentsQuery, feedbackSummaryQuery } from './api.ts';

const dash = (v: number | null) => (v === null ? '–' : String(v));

/**
 * `/admin/feedback` (2B-R8, #299): average rating, NPS and the comment feed for a range. The page
 * renders `api.feedback_summary` and `api.feedback_comments`; it computes no figure itself.
 */
export function FeedbackPage() {
  const { t, i18n } = useTranslation('admin');
  const noVisits = useNoVisitsYet();
  const { location } = useCurrentLocation();
  const [range, setRange] = useState({ from: isoDay(30), to: isoDay() });
  const locationId = location?.id ?? '';
  const r = { locationId, ...range };
  const enabled = !!locationId && range.from <= range.to;
  const overall = useQuery({ ...feedbackSummaryQuery(r, 'all'), enabled });
  const weekly = useQuery({ ...feedbackSummaryQuery(r, 'week'), enabled });
  const comments = useInfiniteQuery({ ...feedbackCommentsQuery(r), enabled });
  if (!location) return <Skeleton label={t('feedback.loading')} rows={2} />;

  const total = overall.data?.[0];
  const list = comments.data?.pages.flat() ?? [];
  const date = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <div className="flex flex-col gap-6 pb-8">
      <PageHeader title={t('feedback.title')} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Input
          label={t('analytics.from')}
          type="date"
          value={range.from}
          onChange={(e) => setRange({ ...range, from: e.target.value })}
        />
        <Input
          label={t('analytics.to')}
          type="date"
          value={range.to}
          onChange={(e) => setRange({ ...range, to: e.target.value })}
        />
      </div>
      {range.from > range.to ? (
        <p role="alert" className="font-medium text-danger-strong">
          {t('analytics.badRange')}
        </p>
      ) : overall.isError || weekly.isError || comments.isError ? (
        <p role="alert" className="font-medium text-danger-strong">
          {t('feedback.error')}
        </p>
      ) : overall.isPending || weekly.isPending || comments.isPending ? (
        <Skeleton label={t('feedback.loading')} rows={3} />
      ) : !total ? (
        noVisits ? (
          <ScreenEmpty kind="feedback" />
        ) : (
          <p>{t('feedback.empty')}</p>
        )
      ) : (
        <>
          <dl data-testid="feedback-tiles" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Tile label={t('feedback.tile.avgRating')} value={dash(total.avgRating)} />
            <Tile label={t('feedback.tile.nps')} value={dash(total.nps)} />
            <Tile label={t('feedback.tile.responses')} value={String(total.responses)} />
            <Tile
              label={t('feedback.tile.responseRate')}
              value={
                total.served === 0
                  ? dash(null)
                  : t('feedback.percent', {
                      value: Math.round((total.responses / total.served) * 100),
                    })
              }
            />
          </dl>
          <section>
            <h2 className="font-medium">{t('feedback.distribution')}</h2>
            <BarChart
              label={t('feedback.distributionLabel')}
              bars={total.ratings.map((n, i) => ({
                key: String(i + 1),
                label: t('feedback.stars', { count: i + 1, responses: n }),
                value: n,
              }))}
            />
            <ul>
              {total.ratings.map((n, i) => (
                <li key={i}>{t('feedback.stars', { count: i + 1, responses: n })}</li>
              ))}
            </ul>
          </section>
          <section>
            <h2 className="font-medium">{t('feedback.split')}</h2>
            <BarChart
              label={t('feedback.splitLabel')}
              bars={[
                {
                  key: 'p',
                  label: `${t('feedback.promoters')}: ${total.promoters}`,
                  value: total.promoters,
                },
                {
                  key: 'a',
                  label: `${t('feedback.passives')}: ${total.passives}`,
                  value: total.passives,
                },
                {
                  key: 'd',
                  label: `${t('feedback.detractors')}: ${total.detractors}`,
                  value: total.detractors,
                },
              ]}
            />
            <p>
              {t('feedback.splitText', {
                promoters: total.promoters,
                passives: total.passives,
                detractors: total.detractors,
              })}
            </p>
          </section>
          <section>
            <h2 className="font-medium">{t('feedback.trend')}</h2>
            <ScrollRegion label={t('feedback.trend')}>
              <table className="w-full text-left">
                <caption className="sr-only">{t('feedback.trend')}</caption>
                <thead>
                  <tr>
                    <th scope="col" className="p-2">
                      {t('feedback.week')}
                    </th>
                    <th scope="col" className="p-2">
                      {t('feedback.tile.responses')}
                    </th>
                    <th scope="col" className="p-2">
                      {t('feedback.tile.avgRating')}
                    </th>
                    <th scope="col" className="p-2">
                      {t('feedback.tile.nps')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {weekly.data.map((w) => (
                    <tr key={w.group} className="border-t border-border">
                      <th scope="row" className="p-2 font-normal">
                        {w.group}
                      </th>
                      <td className="p-2">{w.responses}</td>
                      <td className="p-2">{dash(w.avgRating)}</td>
                      <td className="p-2">{dash(w.nps)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ScrollRegion>
          </section>
          <section>
            <h2 className="font-medium">{t('feedback.comments')}</h2>
            {list.length === 0 ? (
              <p>{t('feedback.noComments')}</p>
            ) : (
              <ul className="flex flex-col gap-3">
                {list.map((c) => (
                  <li key={c.id} className="rounded-control border border-border p-3">
                    <p>{c.comment}</p>
                    <p className="text-sm">
                      {t('feedback.commentMeta', { rating: c.rating })} · {c.ticket}
                      {c.service ? ` · ${c.service}` : ''} · {date.format(new Date(c.createdAt))}
                    </p>
                    {c.guestId ? (
                      <Link
                        to="/admin/guests/$guestId"
                        params={{ guestId: c.guestId }}
                        className="inline-flex min-h-target items-center underline"
                      >
                        {t('feedback.viewHistory')}
                      </Link>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            {comments.hasNextPage ? (
              <Button
                variant="secondary"
                className="mt-3"
                disabled={comments.isFetchingNextPage}
                onClick={() => void comments.fetchNextPage()}
              >
                {t('feedback.loadMore')}
              </Button>
            ) : null}
          </section>
        </>
      )}
    </div>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-control border border-border p-4">
      <dt className="text-sm">{label}</dt>
      <dd className="text-2xl font-semibold">{value}</dd>
    </div>
  );
}
