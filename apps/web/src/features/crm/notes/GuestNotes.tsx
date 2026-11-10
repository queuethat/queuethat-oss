import { Button, ConfirmDestructive, Input } from '@qm/ui';
import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from '../../../lib/translation.tsx';
import { useSession } from '../../auth/api.ts';
import { useCurrentOrg } from '../../auth/current.ts';
import { guestNotesQuery, useAddGuestNote, useDeleteGuestNote } from './api.ts';

/** A guest's notes across visits, newest first. Notes are free text: no health information. */
export function GuestNotes({ guestId }: { guestId: string }) {
  const { t, i18n } = useTranslation('crm');
  const notes = useQuery(guestNotesQuery(guestId));
  const add = useAddGuestNote(guestId);
  const del = useDeleteGuestNote();
  const userId = useSession().data?.user.id;
  const role = useCurrentOrg()?.role;
  const isAdmin = role === 'owner' || role === 'admin';
  const [body, setBody] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!body.trim()) return;
    add.mutate(body, { onSuccess: () => setBody('') });
  };
  return (
    <section aria-labelledby="notes-h" className="flex flex-col gap-3">
      <h2 id="notes-h" className="text-xl font-semibold">
        {t('notes.title')}
      </h2>
      {notes.data?.length === 0 ? <p>{t('notes.none')}</p> : null}
      <ul className="flex flex-col gap-2">
        {notes.data?.map((n) => (
          <li key={n.id} data-testid="guest-note" className="flex flex-wrap items-center gap-3">
            <span className="text-muted">
              {new Date(n.createdAt).toLocaleString(i18n.language)}
            </span>
            <span className="min-w-0 flex-1 whitespace-pre-wrap">{n.body}</span>
            {n.authorId === userId || isAdmin ? (
              <ConfirmDestructive
                triggerLabel={t('notes.delete')}
                triggerAriaLabel={t('notes.deleteFor', { text: n.body.slice(0, 30) })}
                triggerVariant="secondary"
                title={t('notes.deleteTitle')}
                description={t('notes.deleteDescription')}
                confirmLabel={t('notes.deleteConfirm')}
                cancelLabel={t('notes.cancel')}
                onConfirm={() => del.mutateAsync(n.id).catch(() => undefined)}
              />
            ) : null}
          </li>
        ))}
      </ul>
      <form className="flex flex-col gap-3" onSubmit={submit}>
        <Input
          label={t('notes.add')}
          maxLength={2000}
          autoComplete="off"
          value={body}
          onChange={(event) => setBody(event.target.value)}
        />
        <p className="text-muted">{t('notes.healthWarning')}</p>
        <Button
          type="submit"
          className="self-start"
          loading={add.isPending}
          loadingLabel={t('notes.saving')}
        >
          {t('notes.save')}
        </Button>
      </form>
      <p role="alert" className="font-medium text-danger-strong empty:hidden">
        {add.isError ? t('notes.error') : null}
      </p>
    </section>
  );
}
