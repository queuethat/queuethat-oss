import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { Button } from './Button.tsx';
import { ConfirmDialog } from './ConfirmDialog.tsx';
import { cx } from './cx.ts';
import { useDismiss } from './dismiss.ts';
import { Icon } from './Icon.tsx';
import { iconEllipsis, type IconDef } from './icons.ts';

/** Confirmation copy for a destructive item (I-9). Strings already through t(). */
export interface MenuConfirm {
  /** Names the thing: "Remove Maya, A-042?" */
  title: string;
  description?: string;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void | Promise<unknown>;
}

interface MenuItemBase {
  id: string;
  label: string;
  icon?: IconDef;
  disabled?: boolean;
}

/**
 * A menu entry is either a plain action or a destructive one. A destructive entry cannot be
 * declared without `confirm`, so the type enforces I-9: nothing destructive fires from one tap.
 */
export type MenuItem =
  | (MenuItemBase & { onSelect: () => void; confirm?: never })
  | (MenuItemBase & { confirm: MenuConfirm; onSelect?: never });

export interface MenuProps {
  /** Accessible name of the trigger, e.g. "More actions for A-042"; pass through t(). */
  label: string;
  items: MenuItem[];
  /** Trigger content; defaults to an ellipsis icon. */
  trigger?: ReactNode;
  align?: 'start' | 'end';
}

/**
 * Action menu (WAI-ARIA menu button): Enter, Space or ArrowDown on the trigger opens it; Arrow
 * keys, Home, End and typeahead move; Enter or Space picks; Escape closes and returns focus.
 * Items are 48px tall. Row-overflow pattern: keep the one common action as a visible button and
 * put the rest here; destructive items carry `confirm`, which opens `ConfirmDialog`.
 */
export function Menu({ label, items, trigger, align = 'end' }: MenuProps) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState<MenuConfirm | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const start = useRef<'first' | 'last'>('first');
  const typed = useRef({ text: '', at: 0 });
  const id = useId();

  const enabled = items.map((item, i) => (item.disabled ? -1 : i)).filter((i) => i >= 0);

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) button.current?.focus();
  }, []);
  const dismiss = useCallback((viaKeyboard: boolean) => close(viaKeyboard), [close]);
  useDismiss(open, root, dismiss);

  function focusAt(index: number) {
    refs.current[index]?.focus();
  }

  function openMenu(first: 'first' | 'last' = 'first') {
    start.current = first;
    setOpen(true);
  }

  useEffect(() => {
    if (!open || !enabled.length) return;
    focusAt(start.current === 'first' ? enabled[0]! : enabled[enabled.length - 1]!);
    // Only on open; `enabled` is derived from the items at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function onTriggerKeyDown(event: KeyboardEvent) {
    if (open || !enabled.length) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      openMenu('first');
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      openMenu('last');
    }
  }

  function onMenuKeyDown(event: KeyboardEvent) {
    const at = enabled.indexOf(refs.current.findIndex((el) => el === document.activeElement));
    const go = (pos: number) => focusAt(enabled[(pos + enabled.length) % enabled.length]!);
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        return go(at + 1);
      case 'ArrowUp':
        event.preventDefault();
        return go(at - 1);
      case 'Home':
        event.preventDefault();
        return go(0);
      case 'End':
        event.preventDefault();
        return go(enabled.length - 1);
      case 'Tab':
        return close(false);
    }
    if (
      event.key.length === 1 &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      event.key !== ' '
    ) {
      const now = Date.now();
      const state = typed.current;
      state.text = now - state.at > 600 ? event.key : state.text + event.key;
      state.at = now;
      const needle = state.text.toLowerCase();
      const hit = enabled.find((i) => items[i]!.label.toLowerCase().startsWith(needle));
      if (hit !== undefined) focusAt(hit);
    }
  }

  function pick(item: MenuItem) {
    close(true);
    if (item.confirm) setConfirming(item.confirm);
    else item.onSelect();
  }

  return (
    <div ref={root} className="relative inline-block">
      <Button
        ref={button}
        variant="secondary"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => (open ? close(false) : openMenu())}
        onKeyDown={onTriggerKeyDown}
      >
        {trigger ?? <Icon icon={iconEllipsis} />}
      </Button>
      {open ? (
        <div
          id={id}
          role="menu"
          tabIndex={-1}
          aria-label={label}
          onKeyDown={onMenuKeyDown}
          className={cx(
            'absolute z-20 mt-1 flex min-w-52 flex-col rounded-card border border-border bg-surface p-1 text-fg shadow-lg',
            align === 'end' ? 'right-0' : 'left-0',
          )}
        >
          {items.map((item, i) => (
            <button
              key={item.id}
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              role="menuitem"
              tabIndex={-1}
              disabled={item.disabled}
              onClick={() => pick(item)}
              className={cx(
                'flex min-h-target w-full items-center gap-3 rounded-control px-3 text-left hover:bg-secondary-hover focus-visible:bg-secondary-hover disabled:opacity-60',
                item.confirm && 'text-danger',
              )}
            >
              {item.icon ? <Icon icon={item.icon} /> : null}
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
      {confirming ? (
        <ConfirmDialog
          open
          onOpenChange={(next) => {
            if (!next) setConfirming(null);
          }}
          title={confirming.title}
          description={confirming.description}
          confirmLabel={confirming.confirmLabel}
          cancelLabel={confirming.cancelLabel}
          onConfirm={confirming.onConfirm}
        />
      ) : null}
    </div>
  );
}
