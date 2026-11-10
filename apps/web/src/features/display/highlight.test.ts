import { describe, expect, it } from 'vitest';
import { callKey, newCalls } from './highlight.ts';

describe('newCalls', () => {
  const a = callKey({ display_ticket: 'A001', called_at: '2026-10-25T09:00:00Z' });
  const b = callKey({ display_ticket: 'A002', called_at: '2026-10-25T09:01:00Z' });

  it('highlights nothing on the first data, so a reload does not flash the room', () => {
    expect(newCalls(null, [a, b])).toEqual([]);
  });

  it('highlights only calls the screen has not seen', () => {
    expect(newCalls(new Set([a]), [b, a])).toEqual([b]);
  });

  it('highlights a recall of the same ticket again', () => {
    const recall = callKey({ display_ticket: 'A001', called_at: '2026-10-25T09:05:00Z' });
    expect(newCalls(new Set([a]), [recall])).toEqual([recall]);
  });
});
