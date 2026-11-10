import { errorCode } from '@qm/domain';
import { Button, Input } from '@qm/ui';
import { useState } from 'react';
import { useTranslation } from '../../../lib/translation.tsx';
import { useCompanions, useSetCompanions, type NotesTarget } from '../api.ts';

export const COMPANIONS_MAX = 9;
export const COMPANION_NAME_MAX = 40;

/**
 * The party's companion names in the visit sheet (J-14): staff add or remove first names and save
 * them as a whole. The database re-sizes the party and rejects a tenth name.
 */
export function PartyEditor({ visit }: { visit: NotesTarget }) {
  const { t } = useTranslation('staff');
  const stored = useCompanions(visit.id);
  const save = useSetCompanions();
  const [edited, setEdited] = useState<string[] | null>(null);
  const [draft, setDraft] = useState('');
  const names = edited ?? stored.data ?? [];
  const add = () => {
    const name = draft.trim().slice(0, COMPANION_NAME_MAX);
    if (name && names.length < COMPANIONS_MAX) setEdited([...names, name]);
    setDraft('');
  };
  return (
    <section className="flex flex-col gap-2" aria-labelledby={`party-${visit.id}`}>
      <h3 id={`party-${visit.id}`} className="font-medium">
        {t('console.partyEditor.title')}
      </h3>
      <ul className="flex flex-wrap gap-2" aria-label={t('console.partyEditor.title')}>
        {names.map((name, i) => (
          <li key={`${name}-${i}`}>
            <Button
              variant="secondary"
              aria-label={t('console.partyEditor.remove', { name })}
              onClick={() => setEdited(names.filter((_, j) => j !== i))}
            >
              {name} {t('console.detail.removeGlyph')}
            </Button>
          </li>
        ))}
      </ul>
      <form
        className="flex items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          add();
        }}
      >
        <div className="flex-1">
          <Input
            label={t('console.partyEditor.add')}
            value={draft}
            maxLength={COMPANION_NAME_MAX}
            disabled={names.length >= COMPANIONS_MAX}
            hint={names.length >= COMPANIONS_MAX ? t('console.partyEditor.limit') : undefined}
            onChange={(event) => setDraft(event.target.value)}
          />
        </div>
        <Button type="submit" variant="secondary" disabled={draft.trim() === ''}>
          {t('console.partyEditor.addButton')}
        </Button>
      </form>
      {edited ? (
        <Button
          loading={save.isPending}
          onClick={() =>
            save.mutate({ visit, names: edited }, { onSuccess: () => setEdited(null) })
          }
        >
          {t('console.partyEditor.save')}
        </Button>
      ) : null}
      {save.isError ? (
        <p role="alert">
          {errorCode(save.error) === 'stale_visit'
            ? t('console.partyEditor.stale')
            : t('console.partyEditor.failed')}
        </p>
      ) : null}
    </section>
  );
}
