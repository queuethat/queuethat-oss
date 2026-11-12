import { formatLocalTime } from '@qm/domain';
import { Badge, Button, EmptyState, Skeleton, type Tone } from '@qm/ui';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useTranslation } from '../../../lib/translation.tsx';
import { recentTextsQuery, type TextOutcome } from './api.ts';

const TONE: Record<TextOutcome, Tone> = {
  delivered: 'success',
  sent: 'info',
  sending: 'neutral',
  quiet_hours: 'neutral',
  blocked_stop: 'warning',
  not_sent: 'warning',
  failed: 'danger',
};
/** Templates with their own words; anything else is "Other message". */
const TEMPLATES = new Set([
  'called',
  'almost_up',
  'joined',
  'position_changed',
  'eta_changed',
  'broadcast',
  'removed',
  'served',
  'appointment_reminder',
  'appointment_confirmed',
  'no_show_warning',
]);

/**
 * "Recent texts" (T4, #1239): the location's texts of the last week with the outcome the database decides
 * and the number's last two digits, so a shop can answer "did my customer get it?" itself.
 */
export function RecentTexts({ locationId, tz }: { locationId: string; tz: string }) {
  const { t } = useTranslation('staff');
  const texts = useInfiniteQuery(recentTextsQuery(locationId));
  const rows = texts.data?.pages.flat() ?? [];
  return (
    <section aria-labelledby="recent-texts" className="flex flex-col gap-2">
      <h2 id="recent-texts" className="text-xl font-semibold">
        {t('recentTexts.title')}
      </h2>
      <p className="text-muted">{t('recentTexts.intro')}</p>
      {texts.isError ? (
        <p role="alert" className="font-medium text-danger-strong">
          {t('recentTexts.error')}
        </p>
      ) : texts.isPending ? (
        <Skeleton label={t('recentTexts.loading')} rows={3} />
      ) : rows.length === 0 ? (
        <EmptyState title={t('recentTexts.none')} />
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((r) => (
            <li
              key={r.id}
              className="flex flex-wrap items-center gap-2 rounded-card border border-border p-3"
              data-testid="recent-text"
            >
              <Badge tone={TONE[r.outcome]}>{t(`recentTexts.outcome.${r.outcome}`)}</Badge>
              <span className="font-medium">
                {t(
                  TEMPLATES.has(r.template)
                    ? (`recentTexts.template.${r.template}` as never)
                    : 'recentTexts.template.other',
                )}
              </span>
              {r.ticket ? <span>{t('recentTexts.ticket', { ticket: r.ticket })}</span> : null}
              {r.numberHint ? (
                <span className="text-muted">
                  {t('recentTexts.number', { last: r.numberHint })}
                </span>
              ) : null}
              <time dateTime={r.createdAt} className="text-muted">
                {formatLocalTime(r.createdAt, tz)}
              </time>
              {r.outcome !== 'delivered' && r.outcome !== 'sent' && r.outcome !== 'sending' ? (
                <span className="basis-full text-sm text-muted">
                  {t(`recentTexts.why.${r.outcome}`)}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {texts.hasNextPage ? (
        <div>
          <Button
            variant="secondary"
            disabled={texts.isFetchingNextPage}
            onClick={() => void texts.fetchNextPage()}
          >
            {t('recentTexts.more')}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
