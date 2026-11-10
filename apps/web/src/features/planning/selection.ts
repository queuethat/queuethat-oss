import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { COLUMNS } from './grid.ts';

export interface Cell {
  row: number;
  col: number;
}
export interface Selection {
  anchor: Cell;
  head: Cell;
}

/** The rectangle a selection covers, inclusive. */
export function bounds(s: Selection) {
  return {
    r1: Math.min(s.anchor.row, s.head.row),
    r2: Math.max(s.anchor.row, s.head.row),
    c1: Math.min(s.anchor.col, s.head.col),
    c2: Math.max(s.anchor.col, s.head.col),
  };
}

const clamp = (n: number, max: number) => Math.max(0, Math.min(max, n));
const STEP: Record<string, Cell> = {
  ArrowUp: { row: -1, col: 0 },
  ArrowDown: { row: 1, col: 0 },
  ArrowLeft: { row: 0, col: -1 },
  ArrowRight: { row: 0, col: 1 },
};

/**
 * Cell selection for the planning grid, by pointer drag or keyboard (arrows move, shift+arrows
 * extend, Enter confirms, Escape clears; WCAG 2.5.1). `rows` is the number of selectable rows.
 * `onCommit` gets the finished selection.
 */
export function useGridSelection(rows: number, onCommit: (s: Selection) => void) {
  const [selection, setSelection] = useState<Selection | null>(null);
  const [cursor, setCursor] = useState<Cell>({ row: 0, col: 0 });
  const dragging = useRef(false);
  const latest = useRef({ selection, onCommit });
  useEffect(() => {
    latest.current = { selection, onCommit };
  });

  useEffect(() => {
    const end = () => {
      if (!dragging.current) return;
      dragging.current = false;
      const { selection: s, onCommit: commit } = latest.current;
      if (s) commit(s);
      setSelection(null);
    };
    window.addEventListener('pointerup', end);
    return () => window.removeEventListener('pointerup', end);
  }, []);

  const pointerDown = useCallback((cell: Cell) => {
    dragging.current = true;
    setCursor(cell);
    setSelection({ anchor: cell, head: cell });
  }, []);
  const pointerEnter = useCallback((cell: Cell) => {
    if (!dragging.current) return;
    setCursor(cell);
    setSelection((s) => (s ? { ...s, head: cell } : s));
  }, []);
  const clear = useCallback(() => setSelection(null), []);

  const keyDown = useCallback(
    (e: KeyboardEvent) => {
      if (rows === 0) return;
      const step = STEP[e.key];
      if (step) {
        e.preventDefault();
        const next = {
          row: clamp(cursor.row + step.row, rows - 1),
          col: clamp(cursor.col + step.col, COLUMNS - 1),
        };
        setCursor(next);
        setSelection(e.shiftKey ? { anchor: selection?.anchor ?? cursor, head: next } : null);
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onCommit(selection ?? { anchor: cursor, head: cursor });
        setSelection(null);
      } else if (e.key === 'Escape') {
        setSelection(null);
      }
    },
    [rows, cursor, selection, onCommit],
  );

  return { selection, cursor, pointerDown, pointerEnter, keyDown, clear };
}
