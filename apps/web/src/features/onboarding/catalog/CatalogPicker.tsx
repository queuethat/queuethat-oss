import { Button, Card, Input, RadioGroup } from '@qm/ui';
import { useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { useTranslation } from '../../../lib/translation.tsx';
import { catalogQuery, rankCatalog, type CatalogEntry } from './api.ts';

/** At most this many choices at once: one question and a short list, never a grid of cards. */
const SHOWN = 5;

/** A template's display name: the older v1 rows keep their translated names in the locale file. */
export function useTemplateName() {
  const { t } = useTranslation('onboarding');
  return (e: Pick<CatalogEntry, 'key' | 'name'>) =>
    t(`templates.names.${e.key}`, { defaultValue: e.name });
}

/**
 * "What kind of business is this?" (T3, #1297): one search box, a recommended pick from the search
 * or the business name, a preview of what guests will see, and "Use this". Using a template only
 * chooses it; the database copies it when the caller applies it.
 */
export function CatalogPicker({
  chosen,
  onUse,
  hint = '',
  busy = false,
}: {
  /** The template in use, or null while choosing. */
  chosen: CatalogEntry | null;
  /** Called with the template on "Use this", and with null on "Change". */
  onUse: (entry: CatalogEntry | null) => void;
  /** Text to recommend from before anything is typed, such as the business name. */
  hint?: string;
  busy?: boolean;
}) {
  const { t, i18n } = useTranslation('onboarding');
  const name = useTemplateName();
  const headingId = useId();
  const { data: catalog = [] } = useQuery(catalogQuery(i18n.language));
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<string | null>(null);

  if (chosen)
    return (
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p role="status" className="font-medium">
          {t('catalog.basedOn', { name: name(chosen), version: chosen.version })}
        </p>
        <Button variant="secondary" disabled={busy} onClick={() => onUse(null)}>
          {t('catalog.change')}
        </Button>
      </div>
    );

  const ranked = rankCatalog(catalog, query.trim() ? query : hint);
  const recommended = ranked[0] ?? null;
  const shown = (
    query.trim() ? ranked : [...ranked.slice(0, 1), ...catalog.filter((e) => e !== recommended)]
  ).slice(0, SHOWN);
  const preview =
    shown.find((e) => e.key === picked) ?? (picked === null ? recommended : null) ?? null;

  return (
    <div role="group" aria-labelledby={headingId} className="flex flex-col gap-3">
      <p id={headingId} className="font-semibold">
        {t('catalog.question')}
      </p>
      <Input
        label={t('catalog.search')}
        hint={t('catalog.searchHint')}
        type="search"
        value={query}
        // Inside the setup form, Enter searches; it never submits the step.
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.preventDefault();
        }}
        onChange={(e) => {
          setQuery(e.target.value);
          setPicked(null);
        }}
      />
      {shown.length ? (
        <RadioGroup
          label={t('catalog.matches')}
          value={preview?.key ?? ''}
          onChange={setPicked}
          options={shown.map((e) => ({
            value: e.key,
            label: e === recommended ? t('catalog.recommended', { name: name(e) }) : name(e),
            hint: t(`templates.descriptions.${e.key}`, { defaultValue: e.description }),
          }))}
        />
      ) : (
        <p role="status">{t('catalog.noMatch')}</p>
      )}
      {preview ? (
        <>
          <TemplatePreview entry={preview} />
          <Button className="self-start" loading={busy} onClick={() => onUse(preview)}>
            {t('catalog.use')}
          </Button>
        </>
      ) : null}
    </div>
  );
}

/** What a guest sees on the join page once the template is applied, read from the catalog. */
export function TemplatePreview({ entry }: { entry: CatalogEntry }) {
  const { t } = useTranslation('onboarding');
  const name = useTemplateName();
  return (
    <Card
      role="region"
      aria-label={t('catalog.previewLabel', { name: name(entry) })}
      className="flex flex-col gap-3"
    >
      <p className="text-sm font-semibold text-muted">{t('catalog.previewHeading')}</p>
      {entry.queues.map((q, i) => (
        <div key={i} className="flex flex-col gap-1">
          <p className="font-medium">{q.name}</p>
          <ul className="flex flex-col gap-1 pl-4 text-sm">
            {q.services.map((s, j) => (
              <li key={j} className="list-disc">
                {q.showEta && s.minutes
                  ? t('catalog.service', { name: s.name, minutes: s.minutes })
                  : s.name}
              </li>
            ))}
          </ul>
        </div>
      ))}
      {entry.questions.length ? (
        <div className="flex flex-col gap-1">
          <p className="font-medium">{t('catalog.questions')}</p>
          <ul className="flex flex-col gap-1 pl-4 text-sm">
            {entry.questions.map((q, i) => (
              <li key={i} className="list-disc">
                {q.required ? q.label : t('catalog.optional', { label: q.label })}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {entry.waiver ? <p className="text-sm">{t('catalog.waiver')}</p> : null}
      {entry.healthTagged ? (
        <p className="text-sm font-semibold">{t('templates.privacyNote')}</p>
      ) : null}
    </Card>
  );
}
