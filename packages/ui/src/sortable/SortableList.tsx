import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';
import { Button } from '../Button.tsx';
import { cx } from '../cx.ts';
import { Icon } from '../Icon.tsx';
import { moveItem, slotAtPoint } from './geometry.ts';

const iconGrip = 'M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01';
const iconUp = 'M12 19V5M6 11l6-6 6 6';
const iconDown = 'M12 5v14M6 13l6 6 6-6';

export interface SortableItem {
  id: string;
  label: string;
  children?: ReactNode;
}

/** All copy, already through t(). Position arguments are 1-based. */
export interface SortableStrings {
  handle: (label: string) => string;
  moveUp: (label: string) => string;
  moveDown: (label: string) => string;
  grabbed: (label: string, pos: number, total: number) => string;
  moved: (label: string, pos: number, total: number) => string;
  dropped: (label: string, pos: number, total: number) => string;
  cancelled: (label: string) => string;
}

export interface SortableListProps {
  /** Accessible name of the list, already through t(). */
  label: string;
  items: readonly SortableItem[];
  onReorder: (ids: string[]) => void;
  strings: SortableStrings;
  /** False hides the drag/keyboard handle so only the move buttons reorder (default true). */
  draggable?: boolean;
  className?: string;
}

const DIRECTIONS: readonly Exclude<Control, 'handle'>[] = ['up', 'down'];
type Control = 'handle' | 'up' | 'down';

/**
 * Reorderable list where drag, keyboard and move-up/move-down buttons are equals (WCAG 2.2
 * 2.5.7). Drag: pointer on the handle. Keyboard: Space/Enter on the handle picks up, arrows move,
 * Space/Enter drops, Escape cancels. Every change is announced in a live region.
 * Import from `@qm/ui/sortable` and lazy-load it; it is not in the main entry.
 */
export function SortableList({
  label,
  items,
  onReorder,
  strings,
  draggable = true,
  className,
}: SortableListProps) {
  const [message, setMessage] = useState('');
  const [drag, setDragState] = useState<{ id: string; slot: number } | null>(null);
  // The drop reads the slot from here, not from `drag`: a pointerup can arrive before React has
  // rendered the last pointermove, and the handler it runs would still see the previous slot.
  const latestDrag = useRef(drag);
  const setDrag = (next: { id: string; slot: number } | null) => {
    latestDrag.current = next;
    setDragState(next);
  };
  const grabbed = useRef<{ id: string; origin: string[] } | null>(null);
  const list = useRef<HTMLUListElement>(null);
  const controls = useRef(new Map<string, HTMLButtonElement>());
  const refocus = useRef<string | null>(null);
  const keep = (key: string) => (el: HTMLButtonElement | null) => {
    if (el) controls.current.set(key, el);
    else controls.current.delete(key);
  };
  const ids = items.map((i) => i.id);

  useEffect(() => {
    if (refocus.current) controls.current.get(refocus.current)?.focus();
    refocus.current = null;
  });

  const labelOf = (id: string) => items.find((i) => i.id === id)?.label ?? '';

  function move(id: string, to: number, control: Control) {
    const from = ids.indexOf(id);
    const target = Math.min(Math.max(to, 0), ids.length - 1);
    refocus.current = `${id}:${control}`;
    if (from === target) return;
    onReorder(moveItem(ids, from, target));
    setMessage(strings.moved(labelOf(id), target + 1, ids.length));
  }

  function onHandleKey(e: KeyboardEvent, id: string) {
    const held = grabbed.current?.id === id;
    const pos = ids.indexOf(id);
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      if (held) {
        grabbed.current = null;
        setMessage(strings.dropped(labelOf(id), pos + 1, ids.length));
      } else {
        grabbed.current = { id, origin: ids };
        setMessage(strings.grabbed(labelOf(id), pos + 1, ids.length));
      }
    } else if (held && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      move(id, pos + (e.key === 'ArrowUp' ? -1 : 1), 'handle');
    } else if (held && e.key === 'Escape') {
      e.preventDefault();
      onReorder(grabbed.current!.origin);
      grabbed.current = null;
      setMessage(strings.cancelled(labelOf(id)));
    }
  }

  function slotFor(id: string, y: number) {
    const rows = [...(list.current?.querySelectorAll('[data-sortable-item]') ?? [])]
      .filter((r) => (r as HTMLElement).dataset.id !== id)
      .map((r) => r.getBoundingClientRect());
    return slotAtPoint(rows, y);
  }

  function onPointerDown(e: PointerEvent<HTMLButtonElement>, id: string) {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setDrag({ id, slot: ids.indexOf(id) });
  }

  function onPointerMove(e: PointerEvent, id: string) {
    if (latestDrag.current?.id === id) setDrag({ id, slot: slotFor(id, e.clientY) });
  }

  function endDrag(id: string, commit: boolean) {
    const current = latestDrag.current;
    if (current?.id !== id) return;
    const { slot } = current;
    setDrag(null);
    if (!commit) return;
    if (slot !== ids.indexOf(id)) {
      onReorder(moveItem(ids, ids.indexOf(id), slot));
      setMessage(strings.dropped(labelOf(id), slot + 1, ids.length));
    }
  }

  const others = drag ? ids.filter((x) => x !== drag.id) : [];
  return (
    <div className={className}>
      <ul ref={list} aria-label={label} className="flex flex-col gap-2">
        {items.map((item, index) => {
          const before = drag && others[drag.slot] === item.id;
          const after = drag && drag.slot === others.length && others.at(-1) === item.id;
          return (
            <li
              key={item.id}
              data-sortable-item
              data-id={item.id}
              className={cx(
                'flex items-center gap-2 rounded-card border border-border bg-surface p-2',
                drag?.id === item.id && 'opacity-60',
                before && 'border-t-4 border-t-primary',
                after && 'border-b-4 border-b-primary',
              )}
            >
              {draggable ? (
                <Button
                  variant="quiet"
                  aria-label={strings.handle(item.label)}
                  ref={keep(`${item.id}:handle`)}
                  className="min-w-target shrink-0 touch-none cursor-grab px-0"
                  onKeyDown={(e) => onHandleKey(e, item.id)}
                  onBlur={() => {
                    if (grabbed.current?.id === item.id) grabbed.current = null;
                  }}
                  onPointerDown={(e) => onPointerDown(e, item.id)}
                  onPointerMove={(e) => onPointerMove(e, item.id)}
                  onPointerUp={() => endDrag(item.id, true)}
                  onPointerCancel={() => endDrag(item.id, false)}
                >
                  <Icon icon={iconGrip} />
                </Button>
              ) : null}
              <div className="min-w-0 flex-1">{item.children ?? item.label}</div>
              {DIRECTIONS.map((dir) => {
                const edge = dir === 'up' ? index === 0 : index === items.length - 1;
                return (
                  <Button
                    key={dir}
                    variant="quiet"
                    aria-label={(dir === 'up' ? strings.moveUp : strings.moveDown)(item.label)}
                    aria-disabled={edge || undefined}
                    ref={keep(`${item.id}:${dir}`)}
                    className={cx('min-w-target shrink-0 px-0', edge && 'opacity-40')}
                    onClick={() => !edge && move(item.id, index + (dir === 'up' ? -1 : 1), dir)}
                  >
                    <Icon icon={dir === 'up' ? iconUp : iconDown} />
                  </Button>
                );
              })}
            </li>
          );
        })}
      </ul>
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {message}
      </div>
    </div>
  );
}
