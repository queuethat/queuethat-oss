import { Badge, Button, Dialog, Input, Textarea } from '@qm/ui';
import { useState } from 'react';
import { useTranslation } from '../../../lib/translation.tsx';
import type { NotesTarget } from '../api.ts';
import { MessagesSection } from '../messages/Messages.tsx';
import { ChatPanel } from '../chat/ChatPanel.tsx';
import { WhatsAppButton } from '../contact/WhatsAppButton.tsx';
import { PaymentsSection } from '../payments/PaymentsSection.tsx';
import { PartyEditor } from './PartyEditor.tsx';
import { VisitAnswers } from './answers/VisitAnswers.tsx';
import { WaiverRecord } from './waiver/WaiverRecord.tsx';

export const NOTES_MAX = 1000;
export const TAGS_MAX = 10;
export const TAG_MAX = 24;

/** Saves a visit's notes and tags; resolves when the call settles (a failure is shown by the caller). */
export type OnSaveNotes = (visit: NotesTarget, notes: string, tags: string[]) => Promise<boolean>;

/**
 * The visit detail sheet (S-8, #138): staff-only notes with a character count and tag chips, with
 * suggestions from tags already used today. The database trims and de-duplicates tags; this only
 * keeps the form within its limits.
 */
export function VisitDetail({
  visit,
  suggestions,
  open,
  onClose,
  onSave,
}: {
  visit: NotesTarget & { status?: string };
  /** Tags other visits carry today, most useful first. */
  suggestions: string[];
  open: boolean;
  onClose: () => void;
  onSave: OnSaveNotes;
}) {
  const { t } = useTranslation('staff');
  const [notes, setNotes] = useState(visit.notes);
  const [tags, setTags] = useState(visit.tags);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const has = (tag: string) => tags.some((x) => x.toLowerCase() === tag.toLowerCase());
  const add = (raw: string) => {
    const tag = raw.trim().slice(0, TAG_MAX);
    if (tag && !has(tag) && tags.length < TAGS_MAX) setTags([...tags, tag]);
    setDraft('');
  };
  const save = async () => {
    setSaving(true);
    const ok = await onSave(visit, notes, tags);
    setSaving(false);
    if (ok) onClose();
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('console.detail.title', { ticket: visit.ticket })}
      description={t('console.detail.privacy')}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t('console.detail.cancel')}
          </Button>
          <Button loading={saving} onClick={() => void save()}>
            {t('console.detail.save')}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        {open ? <VisitAnswers visit={visit} /> : null}
        {open ? <WaiverRecord visitId={visit.id} /> : null}
        <WhatsAppButton visitId={visit.id} ticket={visit.ticket} />
        {open ? <MessagesSection visitId={visit.id} /> : null}
        {open ? <PaymentsSection visitId={visit.id} visitStatus={visit.status ?? ''} /> : null}
        <PartyEditor visit={visit} />
        <ChatPanel visitId={visit.id} />
        <Textarea
          label={t('console.detail.notes')}
          hint={t('console.detail.count', { count: notes.length, max: NOTES_MAX })}
          value={notes}
          maxLength={NOTES_MAX}
          onChange={(event) => setNotes(event.target.value)}
        />
        <div className="flex flex-col gap-2">
          <span className="font-medium">{t('console.detail.tags')}</span>
          <ul className="flex flex-wrap gap-2" aria-label={t('console.detail.tags')}>
            {tags.map((tag) => (
              <li key={tag}>
                <Button
                  variant="secondary"
                  aria-label={t('console.detail.removeTag', { tag })}
                  onClick={() => setTags(tags.filter((x) => x !== tag))}
                >
                  {tag} {t('console.detail.removeGlyph')}
                </Button>
              </li>
            ))}
          </ul>
          <form
            className="flex items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              add(draft);
            }}
          >
            <div className="flex-1">
              <Input
                label={t('console.detail.newTag')}
                value={draft}
                maxLength={TAG_MAX}
                disabled={tags.length >= TAGS_MAX}
                hint={tags.length >= TAGS_MAX ? t('console.detail.tagLimit') : undefined}
                onChange={(event) => setDraft(event.target.value)}
              />
            </div>
            <Button type="submit" variant="secondary" disabled={draft.trim() === ''}>
              {t('console.detail.addTag')}
            </Button>
          </form>
          {suggestions.filter((s) => !has(s)).length > 0 ? (
            <div
              className="flex flex-wrap gap-2"
              role="group"
              aria-label={t('console.detail.suggestions')}
            >
              {suggestions
                .filter((s) => !has(s))
                .map((s) => (
                  <Button key={s} variant="secondary" onClick={() => add(s)}>
                    {s}
                  </Button>
                ))}
            </div>
          ) : null}
        </div>
      </div>
    </Dialog>
  );
}

/** Tag chips and a note mark on a row, so staff see them without opening the sheet. */
export function RowTags({ visit }: { visit: NotesTarget }) {
  const { t } = useTranslation('staff');
  if (visit.tags.length === 0 && visit.notes === '') return null;
  return (
    <div className="flex flex-wrap gap-1" data-testid="row-tags">
      {visit.notes === '' ? null : (
        <Badge aria-label={t('console.detail.hasNote')}>{t('console.detail.noteGlyph')}</Badge>
      )}
      {visit.tags.map((tag) => (
        <Badge key={tag} tone="info">
          {tag}
        </Badge>
      ))}
    </div>
  );
}
