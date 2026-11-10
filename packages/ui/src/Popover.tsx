import { useCallback, useId, useRef, useState, type ReactNode } from 'react';
import { Button } from './Button.tsx';
import { cx } from './cx.ts';
import { useDismiss } from './dismiss.ts';

export interface PopoverProps {
  /** Accessible name of the trigger button; pass through t(). */
  triggerLabel: string;
  /** What the trigger shows (an `Icon`, or visible text). Defaults to nothing extra. */
  trigger?: ReactNode;
  /** Which edge of the trigger the panel lines up with. */
  align?: 'start' | 'end';
  children: ReactNode;
  className?: string;
}

/**
 * A non-modal panel anchored under a button, for small forms and previews. Escape or a press
 * outside closes it; Escape returns focus to the button. For a list of actions use `Menu`.
 */
export function Popover({
  triggerLabel,
  trigger,
  align = 'start',
  children,
  className,
}: PopoverProps) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();
  const dismiss = useCallback((viaKeyboard: boolean) => {
    setOpen(false);
    if (viaKeyboard) button.current?.focus();
  }, []);
  useDismiss(open, root, dismiss);

  return (
    <div ref={root} className="relative inline-block">
      <Button
        ref={button}
        variant="secondary"
        aria-label={triggerLabel}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        {trigger}
      </Button>
      {open ? (
        <div
          id={id}
          className={cx(
            'absolute z-20 mt-1 min-w-56 rounded-card border border-border bg-surface p-3 text-fg shadow-lg',
            align === 'end' ? 'right-0' : 'left-0',
            className,
          )}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}
