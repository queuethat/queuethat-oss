import { Button, Card } from '@qm/ui';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useTranslation } from '../../../lib/translation.tsx';
import { formatWhen } from '../format.ts';
import type { FunnelStage } from '../funnel.ts';
import {
  attentionQuery,
  useAckAttention,
  type AttentionItem,
  type AttentionReason,
} from './api.ts';

const DAY = 24;
const WEEK = 7 * DAY;

/**
 * "Needs attention (N)" on the console home (#1132): every tenant the database says needs a human,
 * most urgent first. Each row links to the tenant, where billing, messages, devices and support
 * requests live, and can be hidden for a day or a week. A failed load says so: an empty list means
 * nothing needs attention, so it must never be what an error looks like.
 */
export function AttentionQueue() {
  const { t, i18n } = useTranslation('platform');
  const queue = useQuery(attentionQuery);
  const ack = useAckAttention();

  if (queue.isError) {
    return (
      <Card>
        <p role="alert">{t('attention.failed')}</p>
      </Card>
    );
  }
  if (!queue.data) return null;
  const items = queue.data;
  const total = items[0]?.total ?? 0;
  return (
    <Card className="flex flex-col gap-3" aria-labelledby="attention-title">
      <h2 id="attention-title" className="text-xl font-semibold">
        {t('attention.title', { count: total })}
      </h2>
      {ack.isError ? <p role="alert">{t('attention.ackFailed')}</p> : null}
      {items.length === 0 ? (
        <p>{t('attention.none')}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {items.map((item) => (
            <li
              key={`${item.org_id}-${item.reason}`}
              data-testid="attention-item"
              className="flex flex-wrap items-center gap-x-4 gap-y-2"
            >
              <div className="min-w-0 flex-1">
                <Link
                  to="/platform/orgs/$orgId"
                  params={{ orgId: item.org_id }}
                  className="underline"
                >
                  {item.name}
                </Link>{' '}
                <span>{describe(t, item)}</span>{' '}
                {item.since ? (
                  <span className="text-muted">
                    {t('attention.since', { at: formatWhen(item.since, i18n.language, '') })}
                  </span>
                ) : null}
              </div>
              {[DAY, WEEK].map((hours) => (
                <Button
                  key={hours}
                  variant="secondary"
                  loading={
                    ack.isPending &&
                    ack.variables?.orgId === item.org_id &&
                    ack.variables.reason === item.reason &&
                    ack.variables.hours === hours
                  }
                  loadingLabel={t('attention.working')}
                  onClick={() => ack.mutate({ orgId: item.org_id, reason: item.reason, hours })}
                >
                  {t(hours === DAY ? 'attention.snoozeDay' : 'attention.snoozeWeek')}
                </Button>
              ))}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

const REASONS: readonly AttentionReason[] = [
  'support_request_open',
  'payment_past_due',
  'sms_auto_paused',
  'pending_deletion',
  'message_failures',
  'device_offline',
  'plan_limit',
  'login_lockout',
  'stuck_onboarding',
  'no_recent_visits',
  'tagged_attention',
];
type Translate = ReturnType<typeof useTranslation<'platform'>>['t'];

/**
 * The reason in words. Only the numbers the database sent are interpolated, never re-derived; its
 * stage and SMS-pause codes reuse the funnel's and the SMS panel's wording.
 */
function describe(t: Translate, item: AttentionItem): string {
  const known = REASONS.find((r) => r === item.reason);
  if (!known) return t('attention.reasons.unknown');
  const { stage, why, tags, ...numbers } = item.detail;
  return t(`attention.reasons.${known}`, {
    ...numbers,
    tags: Array.isArray(tags) ? tags.join(', ') : '',
    stage:
      typeof stage === 'string'
        ? t(`funnel.stage.${stage as FunnelStage}`, { defaultValue: stage })
        : '',
    why:
      typeof why === 'string'
        ? t(`ops.smsPause.reasons.${why as 'stop_rate'}`, { defaultValue: why })
        : '',
  });
}
