import { useEffect, useId, useRef, type ReactNode, type RefObject } from 'react';
import { cx } from './cx.ts';

export interface DialogProps {
  open: boolean;
  /** Called on Escape. Clicking the backdrop does nothing: accidental dismissal is a bug (S-19). */
  onClose: () => void;
  title: string;
  description?: string;
  children?: ReactNode;
  /** Action row, rendered below the content. */
  footer?: ReactNode;
  /** Element focused on open; defaults to the first focusable one. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  className?: string;
}

/**
 * Modal dialog on the native `<dialog>` element, which gives focus trapping, Escape, inert
 * background and focus restore without a library. Content mounts only while open.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  initialFocusRef,
  className,
}: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      initialFocusRef?.current?.focus();
    }
    if (!open && dialog.open) dialog.close();
  }, [open, initialFocusRef]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      className={cx(
        'm-auto w-[min(32rem,calc(100%-2rem))] rounded-card border border-border bg-surface p-6',
        'text-fg shadow-xl backdrop:bg-black/50',
        className,
      )}
    >
      {open ? (
        <div className="flex flex-col gap-4">
          <h2 id={titleId} className="text-xl font-semibold">
            {title}
          </h2>
          {description ? (
            <p id={descriptionId} className="text-muted">
              {description}
            </p>
          ) : null}
          {children}
          {footer}
        </div>
      ) : null}
    </dialog>
  );
}
