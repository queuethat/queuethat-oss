import { useState, type ReactNode } from 'react';
import { Button, type ButtonVariant } from './Button.tsx';
import { ConfirmDialog } from './ConfirmDialog.tsx';

export interface ConfirmDestructiveProps {
  triggerLabel: string;
  title: string;
  description?: string;
  confirmLabel: string;
  cancelLabel: string;
  /** Runs only after the explicit confirm tap. A returned promise keeps the dialog open and busy. */
  onConfirm: () => void | Promise<unknown>;
  triggerVariant?: Extract<ButtonVariant, 'destructive' | 'secondary'>;
  triggerClassName?: string;
  /** The trigger's accessible name when its visible label needs context, e.g. "Remove A012". */
  triggerAriaLabel?: string;
  disabled?: boolean;
  /** Extra content in the dialog, such as a required reason. */
  children?: ReactNode;
  /** Keeps confirm disabled until the dialog's content is complete. */
  confirmDisabled?: boolean;
}

/**
 * The only way to wire a destructive action (remove, no-show, close queue). The trigger opens a
 * dialog; nothing fires until the separately placed confirm button is tapped. Cancel takes
 * focus, so a double tap or a stray Enter never confirms.
 */
export function ConfirmDestructive({
  triggerLabel,
  title,
  description,
  confirmLabel,
  cancelLabel,
  onConfirm,
  triggerVariant = 'destructive',
  triggerClassName,
  triggerAriaLabel,
  disabled,
  children,
  confirmDisabled,
}: ConfirmDestructiveProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        variant={triggerVariant}
        className={triggerClassName}
        aria-label={triggerAriaLabel}
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        {triggerLabel}
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={title}
        description={description}
        confirmLabel={confirmLabel}
        cancelLabel={cancelLabel}
        onConfirm={onConfirm}
        confirmDisabled={confirmDisabled}
      >
        {children}
      </ConfirmDialog>
    </>
  );
}
