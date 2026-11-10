import { describe, expect, it } from 'vitest';
import type { VisitHistoryEntry } from '../api.ts';
import { timeline } from './entries.ts';

const entry = (
  type: string,
  actor: string,
  summary: Record<string, unknown> = {},
): VisitHistoryEntry => ({
  at: '2026-10-30T10:00:00Z',
  type,
  actor,
  from: null,
  to: null,
  reason: null,
  summary,
});

describe('timeline', () => {
  it('names who undid an entry', () => {
    const rows = timeline([
      entry('joined', 'Guest'),
      entry('call', 'Sam', { undone: true }),
      entry('undo', 'Ana', { undoes_type: 'call' }),
      entry('call', 'Sam'),
    ]);
    expect(rows.map((r) => r.undoneBy)).toEqual([null, 'Ana', null, null]);
  });

  it('pairs two undone calls with their own undos, latest first', () => {
    const rows = timeline([
      entry('call', 'A', { undone: true }),
      entry('undo', 'U1', { undoes_type: 'call' }),
      entry('call', 'B', { undone: true }),
      entry('undo', 'U2', { undoes_type: 'call' }),
    ]);
    expect(rows.map((r) => r.undoneBy)).toEqual(['U1', null, 'U2', null]);
  });

  it('leaves an undone entry unnamed when its undo is not listed', () => {
    expect(timeline([entry('call', 'Sam', { undone: true })])[0]!.undoneBy).toBeNull();
  });
});
