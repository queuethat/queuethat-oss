import { Button, ConfirmDestructive, Input, Spinner, Textarea } from '@qm/ui';
import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from '../../../../lib/translation.tsx';
import { noticesQuery, useAdvanceNotice, useSaveNotice, type IncidentNotice } from './api.ts';

/**
 * The tenant notice for one incident (C9, #1275): draft from the template, edit, approve, send.
 * Sending is its own confirmed step and only an approved notice offers it; the database refuses
 * anything else, so this panel only renders the state it is given.
 */
export function NoticePanel({ incidentId }: { incidentId: string }) {
  const { t } = useTranslation('platform');
  const notices = useQuery(noticesQuery(incidentId));
  const save = useSaveNotice(incidentId);
  const open = notices.data?.find((n) => n.status !== 'sent');
  const sent = notices.data?.filter((n) => n.status === 'sent') ?? [];
  return (
    <section aria-label={t('incidents.notice.title')} className="flex flex-col gap-3">
      <h3 className="font-semibold">{t('incidents.notice.title')}</h3>
      {!notices.data ? (
        <Spinner label={t('ops.loading')} />
      ) : (
        <>
          {sent.map((n) => (
            <p key={n.id} data-testid="notice-sent">
              {t('incidents.notice.sent', {
                orgs: n.org_count ?? 0,
                acknowledged: n.acknowledged_count ?? 0,
              })}
            </p>
          ))}
          {open ? (
            <Editor key={`${open.id}-${open.updated_at}`} notice={open} incidentId={incidentId} />
          ) : (
            <div>
              <Button variant="secondary" disabled={save.isPending} onClick={() => save.mutate({})}>
                {t(sent.length ? 'incidents.notice.followUp' : 'incidents.notice.draft')}
              </Button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function Editor({ notice, incidentId }: { notice: IncidentNotice; incidentId: string }) {
  const { t } = useTranslation('platform');
  const save = useSaveNotice(incidentId);
  const advance = useAdvanceNotice(incidentId);
  const [subject, setSubject] = useState(notice.subject ?? '');
  const [body, setBody] = useState(notice.body ?? '');
  const id = notice.id ?? '';
  const changed = subject !== notice.subject || body !== notice.body;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate({ subject, body });
  };
  return (
    <div className="flex flex-col gap-3">
      <form className="flex flex-col gap-3" onSubmit={submit}>
        <Input
          label={t('incidents.notice.subject')}
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
        />
        <Textarea
          label={t('incidents.notice.body')}
          value={body}
          rows={12}
          onChange={(e) => setBody(e.target.value)}
        />
        <p className="text-muted">{t('incidents.notice.hint')}</p>
        <div>
          <Button type="submit" variant="secondary" disabled={!changed || save.isPending}>
            {t('incidents.notice.save')}
          </Button>
        </div>
      </form>
      <p data-testid="notice-status">{t(`incidents.notice.status.${notice.status as 'draft'}`)}</p>
      {notice.status === 'draft' ? (
        <div>
          <Button
            disabled={changed || advance.isPending}
            onClick={() => advance.mutate({ id, action: 'approve' })}
          >
            {t('incidents.notice.approve')}
          </Button>
        </div>
      ) : (
        <ConfirmDestructive
          triggerLabel={t('incidents.notice.send')}
          title={t('incidents.notice.sendTitle')}
          description={t('incidents.notice.sendBody')}
          confirmLabel={t('incidents.notice.sendConfirm')}
          cancelLabel={t('ops.cancel')}
          onConfirm={() => advance.mutateAsync({ id, action: 'send' })}
        />
      )}
      {(save.isError || advance.isError) && (
        <p role="alert" className="text-danger">
          {t('ops.loadFailed')}
        </p>
      )}
    </div>
  );
}
