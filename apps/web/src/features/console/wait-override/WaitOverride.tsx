import { formatLocalTime } from '@qm/domain';
import { Button, Card, Dialog, Select } from '@qm/ui';
import { useState } from 'react';
import { useTranslation } from '../../../lib/translation.tsx';
import { useNow } from '../../../lib/now.ts';
import { useSetWaitOverride, type ConsoleQueue } from '../api.ts';

const QUICK_PICKS = [15, 30, 45, 60] as const;
/** How long the override lasts; "day" asks far ahead and the database cuts it at the end of the service day. */
const DURATIONS = { '30': 30 * 60_000, '60': 60 * 60_000, day: 24 * 60 * 60_000 } as const;
type Duration = keyof typeof DURATIONS;

/**
 * W-5 (#148): staff say what the wait really is today. The estimate shown to guests follows it
 * until it expires; the banner makes sure nobody forgets it is on. Expiry and the end-of-day cut
 * are the database's; this sends minutes and a time and shows what comes back.
 */
export function WaitOverride({
  queue,
  timeZone,
  part = 'both',
}: {
  queue: ConsoleQueue;
  timeZone: string;
  /** `banner` is the active-override notice only, `action` the button and dialog only. */
  part?: 'banner' | 'action' | 'both';
}) {
  const { t, i18n } = useTranslation('staff');
  const now = useNow(15_000);
  const set = useSetWaitOverride();
  const [open, setOpen] = useState(false);
  const [minutes, setMinutes] = useState<number>(30);
  const [duration, setDuration] = useState<Duration>('60');
  const active =
    queue.waitOverrideMinutes !== null &&
    queue.waitOverrideUntil !== null &&
    Date.parse(queue.waitOverrideUntil) > now;
  const save = () =>
    set.mutate(
      {
        queueId: queue.id,
        minutes,
        until: new Date(Date.now() + DURATIONS[duration]).toISOString(),
      },
      { onSuccess: () => setOpen(false) },
    );
  return (
    <>
      {active && part !== 'action' ? (
        <Card
          role="status"
          className="mb-4 flex flex-wrap items-center justify-between gap-3 bg-warning-soft text-warning-strong"
          data-testid="wait-override-banner"
        >
          <span>
            {t('console.waitOverride.active', {
              minutes: queue.waitOverrideMinutes,
              time: formatLocalTime(queue.waitOverrideUntil!, timeZone, i18n.language),
            })}
          </span>
          <Button
            variant="secondary"
            loading={set.isPending}
            onClick={() => set.mutate({ queueId: queue.id, minutes: null, until: null })}
          >
            {t('console.waitOverride.clear')}
          </Button>
        </Card>
      ) : null}
      {part === 'banner' ? null : (
        <div className="mb-4">
          <Button variant="secondary" onClick={() => setOpen(true)}>
            {t('console.waitOverride.open')}
          </Button>
        </div>
      )}
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={t('console.waitOverride.title', { name: queue.name })}
        description={t('console.waitOverride.hint')}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setOpen(false)}>
              {t('console.waitOverride.cancel')}
            </Button>
            <Button loading={set.isPending} onClick={save}>
              {t('console.waitOverride.save')}
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-4">
          <div
            role="group"
            aria-label={t('console.waitOverride.minutes')}
            className="flex flex-wrap gap-2"
          >
            {QUICK_PICKS.map((m) => (
              <Button
                key={m}
                variant={minutes === m ? 'primary' : 'secondary'}
                aria-pressed={minutes === m}
                onClick={() => setMinutes(m)}
              >
                {t('console.waitOverride.pick', { minutes: m })}
              </Button>
            ))}
          </div>
          <Select
            label={t('console.waitOverride.duration')}
            value={duration}
            onChange={(event) => setDuration(event.target.value as Duration)}
          >
            <option value="30">{t('console.waitOverride.for30')}</option>
            <option value="60">{t('console.waitOverride.for60')}</option>
            <option value="day">{t('console.waitOverride.forDay')}</option>
          </Select>
          {set.isError ? (
            <p role="alert" className="text-danger">
              {t('console.waitOverride.error')}
            </p>
          ) : null}
        </div>
      </Dialog>
    </>
  );
}
