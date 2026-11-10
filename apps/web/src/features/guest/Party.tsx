import { errorCode } from '@qm/domain';
import { BigButton, ConfirmDestructive, Input } from '@qm/ui';
import { useState } from 'react';
import { useTranslation } from '../../lib/translation.tsx';
import { useCompanions, type useVisitStatus } from './api.ts';

type Visit = NonNullable<ReturnType<typeof useVisitStatus>['data']>;
type Companion = { id: string; first_name: string };

/**
 * "Your party" (J-14): the companions the database lists in the status, with add and remove. Never
 * required; the party size and the 9-person cap are the database's call, shown here as its errors.
 */
export function Party({ token, visit }: { token: string; visit: Visit }) {
  const { t } = useTranslation('guest-party');
  const { add, remove } = useCompanions(token);
  const [draft, setDraft] = useState('');
  const companions = ((visit.companions ?? []) as Companion[]).filter(Boolean);
  const error = add.error ?? remove.error;
  const code = error ? errorCode(error) : null;
  return (
    <section className="flex flex-col gap-3" aria-labelledby="party-title">
      <h2 id="party-title" className="text-lg font-semibold">
        {t('title')}
      </h2>
      <p>{t('intro')}</p>
      {companions.length === 0 ? (
        <p>{t('none')}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {companions.map((c) => (
            <li key={c.id} className="flex items-center justify-between gap-2">
              <span>{c.first_name}</span>
              <ConfirmDestructive
                triggerLabel={t('removeTrigger')}
                triggerAriaLabel={t('remove', { name: c.first_name })}
                triggerVariant="secondary"
                title={t('removeTitle', { name: c.first_name })}
                description={t('removeBody')}
                confirmLabel={t('removeConfirm')}
                cancelLabel={t('removeCancel')}
                onConfirm={() => remove.mutateAsync(c.id)}
              />
            </li>
          ))}
        </ul>
      )}
      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const name = draft.trim();
          if (name) add.mutate(name, { onSuccess: () => setDraft('') });
        }}
      >
        <Input
          label={t('add')}
          value={draft}
          maxLength={40}
          disabled={companions.length >= 9}
          hint={companions.length >= 9 ? t('limit') : undefined}
          onChange={(e) => setDraft(e.target.value)}
        />
        <BigButton
          type="submit"
          variant="secondary"
          disabled={draft.trim() === '' || add.isPending}
        >
          {t('addButton')}
        </BigButton>
      </form>
      {error ? (
        <p role="alert">
          {code === 'party_limit'
            ? t('limit')
            : code === 'party_size_out_of_range'
              ? t('tooBig')
              : t('failed')}
        </p>
      ) : null}
    </section>
  );
}
