import { useRef, useState, type ReactNode } from 'react';
import { Button } from './Button.tsx';
import { Dialog } from './Dialog.tsx';

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  confirmLabel: string;
  cancelLabel: string;
  /** Runs only after the explicit confirm tap. A returned promise keeps the dialog open and busy. */
  onConfirm: () => void | Promise<unknown>;
  children?: ReactNode;
  confirmDisabled?: boolean;
}

/**
 * The dialog half of `ConfirmDestructive`, for callers whose trigger lives elsewhere (a menu
 * item). Cancel takes focus, so a stray Enter never confirms; Escape and cancel dismiss; nothing
 * fires until the separate confirm button is tapped.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel,
  onConfirm,
  children,
  confirmDisabled,
}: ConfirmDialogProps) {
  const [pending, setPending] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);

  async function confirm() {
    setPending(true);
    try {
      await onConfirm();
      onOpenChange(false);
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={() => {
        if (!pending) onOpenChange(false);
      }}
      title={title}
      description={description}
      initialFocusRef={cancelRef}
      footer={
        <div className="mt-2 flex justify-between gap-8">
          <Button
            ref={cancelRef}
            variant="secondary"
            disabled={pending}
            onClick={() => onOpenChange(false)}
          >
            {cancelLabel}
          </Button>
          <Button
            variant="destructive"
            loading={pending}
            disabled={confirmDisabled}
            onClick={() => void confirm()}
          >
            {confirmLabel}
          </Button>
        </div>
      }
    >
      {children}
    </Dialog>
  );
}
