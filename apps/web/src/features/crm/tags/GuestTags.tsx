import { Badge, Button, Input } from '@qm/ui';
import { useQuery } from '@tanstack/react-query';
import { useId, useState, type FormEvent } from 'react';
import { useTranslation } from '../../../lib/translation.tsx';
import { guestTagsQuery, orgTagsQuery, useAddGuestTag, useRemoveGuestTag } from './api.ts';

/** The tags on a guest with a create-on-type picker. Chips carry the tag name as text. */
export function GuestTags({ guestId }: { guestId: string }) {
  const { t } = useTranslation('crm');
  const tags = useQuery(guestTagsQuery(guestId));
  const known = useQuery(orgTagsQuery());
  const add = useAddGuestTag(guestId);
  const remove = useRemoveGuestTag(guestId);
  const [name, setName] = useState('');
  const listId = useId();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    add.mutate(name, { onSuccess: () => setName('') });
  };
  const failed =
    add.error?.message === 'forbidden' ? 'tags.errors.forbidden' : 'tags.errors.unknown';
  return (
    <section aria-labelledby="tags-h" className="flex flex-col gap-3">
      <h2 id="tags-h" className="text-xl font-semibold">
        {t('tags.title')}
      </h2>
      {tags.data?.length === 0 ? <p>{t('tags.none')}</p> : null}
      <ul className="flex flex-wrap gap-2">
        {tags.data?.map((tag) => (
          <li key={tag.id} data-testid="guest-tag" className="flex items-center gap-1">
            <Badge tone="info">{tag.name}</Badge>
            <Button
              variant="secondary"
              aria-label={t('tags.remove', { name: tag.name })}
              onClick={() => remove.mutate(tag.id)}
            >
              {t('tags.removeGlyph')}
            </Button>
          </li>
        ))}
      </ul>
      <form className="flex flex-wrap items-end gap-3" onSubmit={submit}>
        <Input
          label={t('tags.add')}
          list={listId}
          maxLength={40}
          autoComplete="off"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <datalist id={listId}>
          {known.data?.map((tag) => (
            <option key={tag.id} value={tag.name} />
          ))}
        </datalist>
        <Button type="submit" loading={add.isPending} loadingLabel={t('tags.saving')}>
          {t('tags.save')}
        </Button>
      </form>
      <p role="alert" className="font-medium text-danger-strong empty:hidden">
        {add.isError ? t(failed as 'tags.errors.unknown') : null}
      </p>
    </section>
  );
}

/** Tag names as chips on a console row (text, never colour alone). */
export function TagChips({ names }: { names?: string[] }) {
  if (!names?.length) return null;
  return (
    <>
      {names.map((n) => (
        <Badge key={n} tone="info" data-testid="guest-tag-chip">
          {n}
        </Badge>
      ))}
    </>
  );
}
