import { describe, expect, it } from 'vitest';
import { POLL_MS } from '../../lib/live.ts';
import { NEXT_POLL_MS, visitPollMs } from './api.ts';

// #548: realtime is at-most-once, so the guest about to be called polls faster.
describe('visitPollMs', () => {
  it('polls every 5 s while waiting with nobody ahead', () => {
    expect(visitPollMs({ status: 'waiting', people_ahead: 0 })).toBe(NEXT_POLL_MS);
  });

  it('polls every 30 s otherwise', () => {
    expect(visitPollMs(undefined)).toBe(POLL_MS);
    expect(visitPollMs({ status: 'waiting', people_ahead: 1 })).toBe(POLL_MS);
    expect(visitPollMs({ status: 'called', people_ahead: null })).toBe(POLL_MS);
  });
});
