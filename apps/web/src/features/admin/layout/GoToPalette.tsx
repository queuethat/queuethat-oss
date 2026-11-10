import { Button, Dialog, Icon, Input } from '@qm/ui';
import { useNavigate } from '@tanstack/react-router';
import { useId, useState, type KeyboardEvent } from 'react';
import { useTranslation } from '../../../lib/translation.tsx';
import type { NavGroup } from '@qm/ui';
import { type AdminNavItem } from './navModel.ts';

/** Case-insensitive match on the page name or its group name. Empty query matches everything. */
export function filterPalette(
  groups: NavGroup<AdminNavItem>[],
  query: string,
): { item: AdminNavItem; group: string | undefined }[] {
  const needle = query.trim().toLowerCase();
  return groups
    .flatMap((g) => g.items.map((item) => ({ item, group: g.label })))
    .filter(
      ({ item, group }) =>
        !needle ||
        item.label.toLowerCase().includes(needle) ||
        (group?.toLowerCase().includes(needle) ?? false),
    );
}

/**
 * "Go to…" (Ctrl or Cmd + K): searches every page this member may open, advanced ones included,
 * and navigates. Combobox pattern: the field keeps focus; arrows move the active option.
 */
export function GoToPalette({
  open,
  onClose,
  groups,
}: {
  open: boolean;
  onClose: () => void;
  groups: NavGroup<AdminNavItem>[];
}) {
  const { t } = useTranslation('admin-nav');
  const navigate = useNavigate();
  const listId = useId();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const results = filterPalette(groups, query);
  const index = Math.min(active, Math.max(results.length - 1, 0));

  function go(item: AdminNavItem) {
    onClose();
    setQuery('');
    setActive(0);
    void navigate({ to: item.to });
  }

  function onKeyDown(event: KeyboardEvent) {
    if (!results.length) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((index + 1) % results.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((index - 1 + results.length) % results.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      go(results[index]!.item);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={() => {
        setQuery('');
        setActive(0);
        onClose();
      }}
      title={t('goTo.title')}
      footer={
        <div className="flex items-center justify-between gap-4">
          <p className="text-sm text-muted">{t('goTo.hint')}</p>
          <Button variant="secondary" onClick={onClose}>
            {t('goTo.close')}
          </Button>
        </div>
      }
    >
      <Input
        label={t('goTo.label')}
        role="combobox"
        aria-expanded
        aria-controls={listId}
        aria-activedescendant={results.length ? `${listId}-${index}` : undefined}
        autoComplete="off"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
        }}
        onKeyDown={onKeyDown}
      />
      <p role="status" className="sr-only">
        {t('goTo.results', { count: results.length })}
      </p>
      {results.length ? (
        <ul
          id={listId}
          role="listbox"
          aria-label={t('goTo.title')}
          className="max-h-80 overflow-auto"
        >
          {results.map(({ item, group }, i) => (
            // eslint-disable-next-line jsx-a11y/click-events-have-key-events -- the combobox field handles the keyboard
            <li
              key={item.id}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === index}
              onClick={() => go(item)}
              className="flex min-h-target cursor-pointer items-center gap-3 rounded-control px-3 aria-selected:bg-secondary"
            >
              {item.icon ? <Icon icon={item.icon} /> : null}
              <span className="min-w-0 flex-1">{item.label}</span>
              {group ? <span className="text-sm text-muted">{group}</span> : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted">{t('goTo.noMatch')}</p>
      )}
    </Dialog>
  );
}
