import { Button, Input } from '@qm/ui';
import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from '../../../lib/translation.tsx';
import { sendWindowQuery, useSaveSendWindow, type SendWindow } from './api.ts';

const KNOWN = ['send_window_out_of_bounds', 'invalid_input', 'permission_denied'];

/**
 * Q1 (#1240): the hours a location's non-urgent texts may go out. The database keeps the window
 * inside the legal envelope and decides which messages wait (`private.send_window_open`).
 */
export function SendWindowSection({
  locationId,
  tz,
  readOnly,
}: {
  locationId: string;
  tz: string;
  readOnly: boolean;
}) {
  const saved = useQuery(sendWindowQuery(locationId));
  if (!saved.data) return null;
  return (
    <SendWindowForm
      key={locationId}
      locationId={locationId}
      tz={tz}
      readOnly={readOnly}
      saved={saved.data}
    />
  );
}

function SendWindowForm({
  locationId,
  tz,
  readOnly,
  saved,
}: {
  locationId: string;
  tz: string;
  readOnly: boolean;
  saved: SendWindow;
}) {
  const { t } = useTranslation('admin-hours');
  const save = useSaveSendWindow(locationId);
  const [hours, setHours] = useState(saved);
  const code = save.error?.message ?? '';
  const change = (patch: Partial<SendWindow>) => {
    save.reset();
    setHours((h) => ({ ...h, ...patch }));
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!readOnly) save.mutate(hours);
  };
  return (
    <section
      aria-labelledby="send-window-title"
      className="mx-auto flex w-full max-w-2xl flex-col gap-3 pb-8"
    >
      <h2 id="send-window-title" className="text-xl font-semibold">
        {t('sendWindow.title')}
      </h2>
      <p className="text-muted">{t('sendWindow.intro', { tz })}</p>
      <form className="flex flex-wrap items-end gap-3" onSubmit={submit}>
        <Input
          label={t('sendWindow.start')}
          type="time"
          required
          value={hours.start}
          readOnly={readOnly}
          onChange={(e) => change({ start: e.target.value })}
        />
        <Input
          label={t('sendWindow.end')}
          type="time"
          required
          value={hours.end}
          readOnly={readOnly}
          onChange={(e) => change({ end: e.target.value })}
        />
        {readOnly ? null : (
          <Button type="submit" loading={save.isPending} loadingLabel={t('saving')}>
            {t('sendWindow.save')}
          </Button>
        )}
      </form>
      {/* Rendered only when there is something to say: the opening-hours form above owns the page's live regions. */}
      {save.error ? (
        <p role="alert" className="font-medium text-danger-strong">
          {t(
            `sendWindow.errors.${KNOWN.includes(code) ? code : 'unknown'}` as 'sendWindow.errors.unknown',
          )}
        </p>
      ) : null}
      {save.isSuccess ? (
        <p role="status" className="font-medium">
          {t('sendWindow.saved')}
        </p>
      ) : null}
    </section>
  );
}
