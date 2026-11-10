import { Badge, Button, Card, Checkbox, Input, Spinner, Textarea } from '@qm/ui';
import { useQuery } from '@tanstack/react-query';
import { useRef, useState, type FormEvent } from 'react';
import { useTranslation } from '../../../lib/translation.tsx';
import { formatWhen } from '../format.ts';
import { opsError } from '../ops/api.ts';
import { notesQuery, parseTags, SUGGESTED_TAGS, useAddNote, type OrgNote } from './api.ts';

/** Longest note the database stores. */
const MAX_BODY = 4000;

/**
 * Internal notes and tags on one tenant. Only support and operators see this; the tenant never
 * does. Notes are append-only: an edit writes a new version and the earlier ones stay in history.
 */
export function NotesSection({ orgId }: { orgId: string }) {
  const { t, i18n } = useTranslation('platform');
  const [history, setHistory] = useState(false);
  const notes = useQuery(notesQuery(orgId, history));
  const add = useAddNote();
  const [body, setBody] = useState('');
  const [tags, setTags] = useState('');
  const [editing, setEditing] = useState<OrgNote | null>(null);
  // One key per form submit, kept until it succeeds, so a retry after a timeout can't double-post.
  const key = useRef(crypto.randomUUID());

  const reset = () => {
    setBody('');
    setTags('');
    setEditing(null);
    key.current = crypto.randomUUID();
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    add.mutate(
      {
        orgId,
        body,
        tags: parseTags(tags),
        noteId: editing?.id,
        idempotencyKey: key.current,
      },
      { onSuccess: reset },
    );
  };
  const edit = (note: OrgNote) => {
    setEditing(note);
    setBody(note.body);
    setTags(note.tags.join(', '));
    key.current = crypto.randomUUID();
    add.reset();
  };

  return (
    <Card className="flex flex-col gap-4" aria-label={t('notes.title')}>
      <h2 className="text-xl font-semibold">{t('notes.title')}</h2>
      <p className="text-muted">{t('notes.warning')}</p>

      <form className="flex flex-col gap-3" onSubmit={submit}>
        <Textarea
          label={editing ? t('notes.editLabel') : t('notes.bodyLabel')}
          value={body}
          maxLength={MAX_BODY}
          onChange={(event) => setBody(event.target.value)}
          hint={t('notes.bodyHint', { max: MAX_BODY })}
        />
        <Input
          label={t('notes.tagsLabel')}
          hint={t('notes.tagsHint', { suggestions: SUGGESTED_TAGS.join(', ') })}
          value={tags}
          onChange={(event) => setTags(event.target.value)}
        />
        {add.isError ? (
          <p role="alert" className="font-medium text-danger-strong">
            {t(`notes.errors.${opsError(add.error)}`)}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-3">
          <Button type="submit" disabled={body.trim() === '' || add.isPending}>
            {editing ? t('notes.saveEdit') : t('notes.add')}
          </Button>
          {editing ? (
            <Button type="button" variant="secondary" onClick={reset}>
              {t('notes.cancelEdit')}
            </Button>
          ) : null}
        </div>
      </form>

      <Checkbox
        label={t('notes.showHistory')}
        checked={history}
        onChange={(event) => setHistory(event.target.checked)}
      />

      {notes.isError ? (
        <p role="alert">{t('ops.loadFailed')}</p>
      ) : !notes.data ? (
        <Spinner label={t('notes.loading')} />
      ) : notes.data.length === 0 ? (
        <p>{t('notes.empty')}</p>
      ) : (
        <ul className="flex flex-col gap-4">
          {notes.data.map((note) => (
            <li key={note.version_id} data-testid="note" className="flex flex-col gap-2">
              <p className="whitespace-pre-wrap break-words">{note.body}</p>
              {note.tags.length > 0 ? (
                <ul className="flex flex-wrap gap-2" aria-label={t('notes.noteTags')}>
                  {note.tags.map((tag) => (
                    <li key={tag}>
                      <Badge>{tag}</Badge>
                    </li>
                  ))}
                </ul>
              ) : null}
              <p className="text-sm text-muted">
                {t('notes.byline', {
                  author: note.author_email ?? t('notes.unknownAuthor'),
                  at: formatWhen(note.created_at, i18n.language, ''),
                })}
                {note.version > 1 ? ` · ${t('notes.version', { version: note.version })}` : ''}
              </p>
              {!history ||
              note.version ===
                Math.max(...notes.data.filter((n) => n.id === note.id).map((n) => n.version)) ? (
                <div>
                  <Button type="button" variant="secondary" onClick={() => edit(note)}>
                    {t('notes.edit')}
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
