import { Button, Card, Input, TicketNumber } from '@qm/ui';
import { useEffect, useState } from 'react';
import { useTranslation } from '../../../lib/translation.tsx';
import { ACTIVE_STATES, useSearchVisits, useVisitForDetail, type SearchHit } from '../api.ts';
import { VisitDetail, type OnSaveNotes } from '../detail/VisitDetail.tsx';
import { HistoryDrawer } from '../history/HistoryDrawer.tsx';
import { isFiltering, NO_FILTERS, toggle, type Filters } from './filters.ts';

const DEBOUNCE_MS = 300;

/**
 * Filter chips for the live list and a debounced search over today and yesterday (S-9, #141).
 * Chips narrow what is already loaded; the search box asks the database, which also finds
 * finished visits. A hit opens the notes and tags sheet in one tap, or its history.
 */
export function ConsoleSearch({
  locationId,
  timeZone,
  services,
  tags,
  filters,
  onFilters,
  onSaveNotes,
}: {
  locationId: string;
  timeZone: string;
  /** Service and tag names present in the loaded list, for the chips. */
  services: string[];
  tags: string[];
  filters: Filters;
  onFilters: (next: Filters) => void;
  onSaveNotes: OnSaveNotes;
}) {
  const { t } = useTranslation('staff');
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  useEffect(() => {
    const id = setTimeout(() => setQuery(text.trim()), DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [text]);
  const search = useSearchVisits(locationId, query);
  const [openId, setOpenId] = useState<string | null>(null);
  const [historyOf, setHistoryOf] = useState<SearchHit | null>(null);
  const target = useVisitForDetail(openId);

  const chip = (label: string, on: boolean, onClick: () => void) => (
    <Button key={label} variant={on ? 'primary' : 'secondary'} aria-pressed={on} onClick={onClick}>
      {label}
    </Button>
  );
  const hits = query.length >= 2 ? (search.data ?? []) : [];
  return (
    <section aria-label={t('console.search.section')} className="mb-4 flex flex-col gap-3">
      <Input
        type="search"
        data-shortcut="search"
        label={t('console.search.label')}
        hint={t('console.search.hint')}
        value={text}
        maxLength={80}
        onChange={(event) => setText(event.target.value)}
      />
      <div
        className="flex flex-wrap items-center gap-2"
        role="group"
        aria-label={t('console.search.filters')}
      >
        {chip(t('console.search.mine'), filters.mine, () =>
          onFilters({ ...filters, mine: !filters.mine }),
        )}
        {ACTIVE_STATES.map((s) =>
          chip(t(`console.search.status.${s}`), filters.statuses.includes(s), () =>
            onFilters({ ...filters, statuses: toggle(filters.statuses, s) }),
          ),
        )}
        {services.map((s) =>
          chip(s, filters.services.includes(s), () =>
            onFilters({ ...filters, services: toggle(filters.services, s) }),
          ),
        )}
        {tags.map((tag) =>
          chip(`#${tag}`, filters.tags.includes(tag), () =>
            onFilters({ ...filters, tags: toggle(filters.tags, tag) }),
          ),
        )}
        {isFiltering(filters) ? (
          <Button variant="secondary" onClick={() => onFilters(NO_FILTERS)}>
            {t('console.search.clear')}
          </Button>
        ) : null}
      </div>
      {query.length >= 2 ? (
        <div role="region" aria-label={t('console.search.results')} className="flex flex-col gap-2">
          {search.isError ? (
            <p role="alert">{t('console.search.error')}</p>
          ) : hits.length === 0 && !search.isFetching ? (
            <p className="text-muted">{t('console.search.none')}</p>
          ) : (
            <ol className="flex flex-col gap-2">
              {hits.map((h) => (
                <li key={h.id} data-testid="search-hit">
                  <Card className="flex flex-wrap items-center gap-4">
                    <TicketNumber ticket={h.ticket} size="phone" className="w-24 shrink-0" />
                    <span className="min-w-0 flex-1 truncate">
                      {[h.name ?? t('console.noName'), h.service].filter(Boolean).join(' · ')}
                    </span>
                    <span className="text-muted">
                      {t(`console.search.state.${h.status}`, { defaultValue: h.status })}
                    </span>
                    <Button
                      variant="secondary"
                      aria-label={t('console.detail.open', { ticket: h.ticket })}
                      onClick={() => setOpenId(h.id)}
                    >
                      {t('console.search.open')}
                    </Button>
                    <Button
                      variant="secondary"
                      aria-label={t('console.history.openFor', { ticket: h.ticket })}
                      onClick={() => setHistoryOf(h)}
                    >
                      {t('console.history.open')}
                    </Button>
                  </Card>
                </li>
              ))}
            </ol>
          )}
        </div>
      ) : null}
      {openId && target.data ? (
        <VisitDetail
          visit={target.data}
          suggestions={tags}
          open
          onClose={() => setOpenId(null)}
          onSave={onSaveNotes}
        />
      ) : null}
      {historyOf ? (
        <HistoryDrawer
          visitId={historyOf.id}
          ticket={historyOf.ticket}
          timeZone={timeZone}
          onClose={() => setHistoryOf(null)}
        />
      ) : null}
    </section>
  );
}
