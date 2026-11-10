import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { cx } from './cx.ts';

export interface TabItem {
  id: string;
  label: ReactNode;
  /** Shown after the label, e.g. a waiting count or a paused badge. */
  extra?: ReactNode;
}

export interface TabsProps {
  /** Accessible name of the tab list; pass through t(). */
  label: string;
  items: TabItem[];
  value: string;
  onChange: (id: string) => void;
  /** Id of the element the selected tab controls (`role="tabpanel"`). */
  panelId: string;
}

/**
 * A row of tabs (WAI-ARIA tabs pattern): one tab stop, arrow keys, Home and End move and select.
 * Each tab is at least 48px tall (S-11); the row scrolls sideways rather than overflowing the page
 * when a location has more queues than fit.
 */
export function Tabs({ label, items, value, onChange, panelId }: TabsProps) {
  const refs = useRef(new Map<string, HTMLButtonElement>());

  function move(event: KeyboardEvent, index: number) {
    const last = items.length - 1;
    const next =
      event.key === 'ArrowRight'
        ? (index + 1) % items.length
        : event.key === 'ArrowLeft'
          ? (index - 1 + items.length) % items.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? last
              : null;
    if (next === null) return;
    event.preventDefault();
    const id = items[next]!.id;
    onChange(id);
    refs.current.get(id)?.focus();
  }

  return (
    <div role="tablist" aria-label={label} className="flex gap-2 overflow-x-auto">
      {items.map((item, index) => {
        const selected = item.id === value;
        return (
          <button
            key={item.id}
            ref={(el) => {
              if (el) refs.current.set(item.id, el);
              else refs.current.delete(item.id);
            }}
            type="button"
            role="tab"
            id={`tab-${item.id}`}
            aria-selected={selected}
            aria-controls={panelId}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(item.id)}
            onKeyDown={(event) => move(event, index)}
            className={cx(
              'inline-flex min-h-target shrink-0 items-center gap-2 rounded-control px-4 font-semibold',
              'transition-colors',
              selected
                ? 'bg-primary text-on-primary'
                : 'bg-secondary text-on-secondary hover:bg-secondary-hover',
            )}
          >
            {item.label}
            {item.extra}
          </button>
        );
      })}
    </div>
  );
}
