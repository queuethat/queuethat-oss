import { useState, type ReactNode } from 'react';
import { cx } from './cx.ts';
import { Icon } from './Icon.tsx';
import { iconChevronDown, type IconDef } from './icons.ts';

export interface NavItem {
  id: string;
  label: string;
  icon?: IconDef;
}

export interface NavGroup<T extends NavItem = NavItem> {
  id: string;
  /** Heading and toggle. Omit for a flat, always-open run of items (set off by a divider unless first). */
  label?: string;
  items: T[];
  /** Open on first render even when the current page is elsewhere. */
  defaultOpen?: boolean;
}

export interface NavLinkView {
  className: string;
  /** Icon and label, ready to place inside the link. */
  content: ReactNode;
  current: boolean;
}

export interface SectionNavProps<T extends NavItem> {
  /** Accessible name of the navigation landmark; pass through t(). */
  label: string;
  groups: NavGroup<T>[];
  /** Id of the item for the current page. Its group opens, and reopens when it changes. */
  currentId?: string;
  /** Renders one link with the kit's classes, so the kit stays router-free. */
  renderItem: (item: T, view: NavLinkView) => ReactNode;
  /**
   * localStorage key. When set, the user's open/closed choice per group is remembered per browser
   * (storage failures are ignored). The group holding the current page still opens on arrival.
   */
  storageKey?: string;
}

function readChoices(key?: string): Record<string, boolean> {
  if (!key) return {};
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(key) ?? '{}');
    return raw && typeof raw === 'object' ? (raw as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

function writeChoices(key: string | undefined, choices: Record<string, boolean>) {
  if (!key) return;
  try {
    localStorage.setItem(key, JSON.stringify(choices));
  } catch {
    // Private mode or blocked storage: the choice just isn't remembered.
  }
}

const LINK =
  'flex min-h-target items-center gap-3 rounded-control px-3 hover:bg-secondary-hover aria-[current=page]:bg-secondary aria-[current=page]:font-semibold';

/**
 * Grouped navigation. Each labelled group is a disclosure button over a list; the group holding
 * the current page is open, others start closed unless `defaultOpen`. The caller owns routing.
 */
export function SectionNav<T extends NavItem>({
  label,
  groups,
  currentId,
  renderItem,
  storageKey,
}: SectionNavProps<T>) {
  const holding = groups.find((g) => g.items.some((i) => i.id === currentId))?.id;
  const [choices, setChoices] = useState(() => readChoices(storageKey));
  const [open, setOpen] = useState(
    () =>
      new Set(
        groups
          .filter((g) => g.id === holding || (choices[g.id] ?? g.defaultOpen ?? false))
          .map((g) => g.id),
      ),
  );
  // Adjust during render (not in an effect) when navigation moves to another group.
  const [seen, setSeen] = useState(holding);
  if (holding !== seen) {
    setSeen(holding);
    if (holding && !open.has(holding)) setOpen(new Set(open).add(holding));
  }

  function toggle(id: string) {
    const next = new Set(open);
    const nowOpen = !next.delete(id);
    if (nowOpen) next.add(id);
    setOpen(next);
    const saved = { ...choices, [id]: nowOpen };
    setChoices(saved);
    writeChoices(storageKey, saved);
  }

  function list(group: NavGroup<T>, id?: string) {
    return (
      <ul id={id} className="flex flex-col gap-1">
        {group.items.map((item) => {
          const current = item.id === currentId;
          return (
            <li key={item.id}>
              {renderItem(item, {
                current,
                className: LINK,
                content: (
                  <>
                    {item.icon ? <Icon icon={item.icon} /> : null}
                    <span className="min-w-0">{item.label}</span>
                  </>
                ),
              })}
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <nav aria-label={label} className="flex flex-col gap-1">
      {groups.map((group, index) => {
        if (!group.label) {
          return (
            <div
              key={group.id}
              className={index === 0 ? undefined : 'mt-2 border-t border-border pt-2'}
            >
              {list(group)}
            </div>
          );
        }
        const isOpen = open.has(group.id);
        const panel = `nav-${group.id}`;
        return (
          <div key={group.id}>
            <button
              type="button"
              aria-expanded={isOpen}
              aria-controls={panel}
              onClick={() => toggle(group.id)}
              className={cx(
                'flex min-h-target w-full items-center justify-between rounded-control px-3 text-sm font-semibold uppercase tracking-wide text-muted hover:bg-secondary-hover',
              )}
            >
              {group.label}
              <Icon
                icon={iconChevronDown}
                size="sm"
                className={cx(
                  'transition-transform motion-reduce:transition-none',
                  !isOpen && '-rotate-90',
                )}
              />
            </button>
            {isOpen ? list(group, panel) : null}
          </div>
        );
      })}
    </nav>
  );
}
