import { Button, Icon, iconPlus } from '@qm/ui';
import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { useTranslation } from '../../../../lib/translation.tsx';
import { FIELD_TYPES, type FieldType } from './fields.ts';

const THRESHOLD = 6;

export interface LibraryPaletteProps {
  disabled: boolean;
  /** False (phone width) turns pointer dragging off entirely; tapping still adds. */
  draggable?: boolean;
  /** Tap, Enter or Space on a type adds it at the end. */
  onAdd: (type: FieldType) => void;
  /** A mouse or pen drag released at (x, y); the owner decides whether that is over the canvas. */
  onDrop: (type: FieldType, x: number, y: number) => void;
  /** Reports where a drag currently is (null when none), so the canvas can show a target. */
  onDrag: (point: { x: number; y: number } | null) => void;
}

/**
 * The field library. Tap-to-add is the primary path (WCAG 2.2 2.5.7); a mouse or pen can also
 * drag a type onto the canvas. Touch scrolls the page instead, so it only taps.
 */
export function LibraryPalette({
  disabled,
  draggable = true,
  onAdd,
  onDrop,
  onDrag,
}: LibraryPaletteProps) {
  const { t } = useTranslation('admin-form-builder');
  const [drag, setDrag] = useState<{ type: FieldType; x: number; y: number } | null>(null);
  const press = useRef<{ type: FieldType; x: number; y: number; moved: boolean } | null>(null);
  const swallowClick = useRef(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!drag) return;
    const cancel = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      press.current = null;
      setDrag(null);
      onDrag(null);
    };
    window.addEventListener('keydown', cancel);
    return () => window.removeEventListener('keydown', cancel);
  }, [drag, onDrag]);

  function down(e: PointerEvent, type: FieldType) {
    if (disabled || !draggable || e.button !== 0 || e.pointerType === 'touch') return;
    press.current = { type, x: e.clientX, y: e.clientY, moved: false };
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  }

  function move(e: PointerEvent) {
    const p = press.current;
    if (!p) return;
    if (!p.moved && Math.hypot(e.clientX - p.x, e.clientY - p.y) < THRESHOLD) return;
    p.moved = true;
    setDrag({ type: p.type, x: e.clientX, y: e.clientY });
    onDrag({ x: e.clientX, y: e.clientY });
  }

  function up(e: PointerEvent) {
    const p = press.current;
    press.current = null;
    if (!p?.moved) return;
    swallowClick.current = true;
    setDrag(null);
    onDrag(null);
    onDrop(p.type, e.clientX, e.clientY);
  }

  return (
    <div>
      <ul aria-label={t('library.label')} className="flex flex-wrap gap-2">
        {FIELD_TYPES.map((type) => (
          <li key={type}>
            <Button
              variant="secondary"
              disabled={disabled}
              aria-label={t('library.add', { name: t(`types.${type}`) })}
              className={draggable ? 'cursor-grab' : undefined}
              onPointerDown={(e) => down(e, type)}
              onPointerMove={move}
              onPointerUp={up}
              onPointerCancel={() => {
                press.current = null;
                setDrag(null);
                onDrag(null);
              }}
              onClick={() => {
                if (swallowClick.current) {
                  swallowClick.current = false;
                  return;
                }
                onAdd(type);
                setMessage(t('library.added', { name: t(`types.${type}`) }));
              }}
            >
              <Icon icon={iconPlus} size="sm" />
              {t(`types.${type}`)}
            </Button>
          </li>
        ))}
      </ul>
      {drag ? (
        <span
          aria-hidden="true"
          style={{ left: drag.x + 12, top: drag.y + 12 }}
          className="pointer-events-none fixed z-50 rounded-control bg-primary px-3 py-1 text-sm font-semibold text-on-primary shadow-lg"
        >
          {t(`types.${drag.type}`)}
        </span>
      ) : null}
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {message}
      </div>
    </div>
  );
}
