import { Button, ConfirmDestructive, Input, Select, Textarea } from '@qm/ui';
import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from '../../../../../lib/translation.tsx';
import {
  guestNoticesQuery,
  noticeLocationsQuery,
  useAdvanceGuestNotice,
  useSaveGuestNotice,
  type GuestNotice,
} from './api.ts';

const day = (iso: string | null) => (iso ? iso.slice(0, 10) : '');
const startOf = (date: string) => new Date(`${date}T00:00:00`).toISOString();
const endOf = (date: string) =>
  new Date(new Date(`${date}T00:00:00`).getTime() + 86_400_000).toISOString();

/**
 * Tell the guests of this incident (C10, #1276): an admin drafts, an owner approves and sends.
 * Nothing sends on its own; the database refuses a draft and anything past its caps, so this
 * panel only renders the state it is given. Only a count is shown, never who.
 */
export function GuestNoticePanel({
  logId,
  orgId,
  isOwner,
}: {
  logId: string;
  orgId: string;
  isOwner: boolean;
}) {
  const { t } = useTranslation('admin-privacy');
  const notices = useQuery(guestNoticesQuery(logId));
  const open = notices.data?.find((n) => n.status !== 'sent');
  const sent = notices.data?.filter((n) => n.status === 'sent') ?? [];
  return (
    <section aria-label={t('privacy.guestNotice.title')} className="flex flex-col gap-2">
      <h4 className="font-medium">{t('privacy.guestNotice.title')}</h4>
      {sent.map((n) => (
        <p key={n.id} data-testid="guest-notice-sent">
          {t('privacy.guestNotice.sent', { count: n.recipient_count ?? 0 })}
        </p>
      ))}
      <Editor
        key={open ? `${open.id}-${open.updated_at}` : 'new'}
        logId={logId}
        orgId={orgId}
        notice={open}
        isOwner={isOwner}
      />
    </section>
  );
}

function Editor({
  logId,
  orgId,
  notice,
  isOwner,
}: {
  logId: string;
  orgId: string;
  notice: GuestNotice | undefined;
  isOwner: boolean;
}) {
  const { t } = useTranslation('admin-privacy');
  const locations = useQuery(noticeLocationsQuery(orgId));
  const save = useSaveGuestNotice(logId);
  const advance = useAdvanceGuestNotice(logId);
  const [subject, setSubject] = useState(notice?.subject ?? '');
  const [body, setBody] = useState(notice?.body ?? '');
  const [from, setFrom] = useState(day(notice?.window_from ?? null));
  const [to, setTo] = useState(
    day(notice?.window_to ? new Date(Date.parse(notice.window_to) - 1).toISOString() : null),
  );
  const [locationId, setLocationId] = useState(notice?.location_id ?? '');
  const changed =
    !notice ||
    locationId !== (notice.location_id ?? '') ||
    subject !== notice.subject ||
    body !== notice.body ||
    from !== day(notice.window_from);
  const ready = subject.trim() && body.trim() && from && to && to >= from;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (ready) save.mutate({ subject, body, from: startOf(from), to: endOf(to), locationId });
  };
  return (
    <div className="flex flex-col gap-2">
      <form className="flex flex-col gap-2" onSubmit={submit}>
        <Input
          label={t('privacy.guestNotice.subject')}
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
        />
        <Textarea
          label={t('privacy.guestNotice.body')}
          value={body}
          rows={6}
          onChange={(e) => setBody(e.target.value)}
        />
        <Input
          label={t('privacy.guestNotice.from')}
          type="date"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
        />
        <Input
          label={t('privacy.guestNotice.to')}
          type="date"
          value={to}
          onChange={(e) => setTo(e.target.value)}
        />
        {locations.data && locations.data.length > 1 ? (
          <Select
            label={t('privacy.guestNotice.location')}
            value={locationId}
            onChange={(e) => setLocationId(e.target.value)}
          >
            <option value="">{t('privacy.guestNotice.allLocations')}</option>
            {locations.data.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </Select>
        ) : null}
        <p className="text-muted">{t('privacy.guestNotice.hint')}</p>
        <div>
          <Button type="submit" variant="secondary" disabled={!ready || !changed || save.isPending}>
            {t('privacy.guestNotice.save')}
          </Button>
        </div>
      </form>
      {notice ? (
        <>
          <p data-testid="guest-notice-status">
            {t(`privacy.guestNotice.status.${notice.status as 'draft'}`, {
              count: notice.recipient_count ?? 0,
            })}
          </p>
          {!isOwner ? (
            <p className="text-muted">{t('privacy.guestNotice.ownerOnly')}</p>
          ) : notice.status === 'draft' ? (
            <div>
              <Button
                disabled={changed || advance.isPending}
                onClick={() => advance.mutate({ id: notice.id ?? '', action: 'approve' })}
              >
                {t('privacy.guestNotice.approve')}
              </Button>
            </div>
          ) : (
            <ConfirmDestructive
              triggerLabel={t('privacy.guestNotice.send')}
              title={t('privacy.guestNotice.sendTitle')}
              description={t('privacy.guestNotice.sendBody', {
                count: notice.recipient_count ?? 0,
              })}
              confirmLabel={t('privacy.guestNotice.sendConfirm')}
              cancelLabel={t('privacy.guestNotice.cancel')}
              onConfirm={() => advance.mutateAsync({ id: notice.id ?? '', action: 'send' })}
            />
          )}
        </>
      ) : null}
      {(save.isError || advance.isError) && (
        <p role="alert" className="text-danger">
          {t(
            (advance.error ?? save.error)?.message === 'rate_limited'
              ? 'privacy.guestNotice.capped'
              : 'privacy.guestNotice.error',
          )}
        </p>
      )}
    </div>
  );
}
