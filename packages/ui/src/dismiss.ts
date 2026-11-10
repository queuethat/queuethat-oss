import { useEffect, type RefObject } from 'react';

/**
 * While `open`: Escape and a pointer press outside `container` call `onDismiss`. Escape reports
 * `viaKeyboard` so the caller can return focus to its trigger.
 */
export function useDismiss(
  open: boolean,
  container: RefObject<HTMLElement | null>,
  onDismiss: (viaKeyboard: boolean) => void,
) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onDismiss(true);
    };
    const onPointer = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) onDismiss(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [open, container, onDismiss]);
}
