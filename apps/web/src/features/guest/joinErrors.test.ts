import { describe, expect, it } from 'vitest';
import { RpcError } from './client.ts';
import { joinErrorKey, refusalReason } from './joinErrors.ts';

describe('joinErrorKey', () => {
  it('sends guests to the desk when the hourly online ceiling is hit', () => {
    const err = new RpcError('rate_limited', 'P0001', 'queue_total', 400);
    expect(joinErrorKey('rate_limited', err)).toBe('rate_limited_total');
  });

  it.each([
    ['client', 'rate_limited_phone'],
    ['network', 'rate_limited_network'],
  ])(
    'sends guests to staff, saying whether the phone or the network is over (%s)',
    (detail, key) => {
      const err = new RpcError('rate_limited', 'P0001', detail, 400);
      expect(joinErrorKey('rate_limited', err)).toBe(key);
    },
  );

  it.each(['queue', null])('keeps "try again" for the per-minute queue limit (%s)', (detail) => {
    const err = new RpcError('rate_limited', 'P0001', detail, 400);
    expect(joinErrorKey('rate_limited', err)).toBe('rate_limited');
  });

  it('gives a refused Turnstile check its own copy, from join-pass or the database', () => {
    expect(
      joinErrorKey(
        'captcha_required',
        new RpcError('captcha_required', 'captcha_required', null, 403),
      ),
    ).toBe('captcha_required');
  });

  it('maps undocumented codes to unknown', () => {
    expect(joinErrorKey('stale_visit', new Error('stale_visit'))).toBe('unknown');
  });
});

// #603: a join the database refuses because the queue just stopped taking guests says what the
// page says when it learns that by itself, not a different sentence.
describe('refusalReason', () => {
  it.each(['closed', 'paused', 'outside_hours', 'full'])(
    'reads the reason the database gave for queue_not_accepting (%s)',
    (reason) => {
      const err = new RpcError('queue_not_accepting', 'P0001', reason, 400);
      expect(refusalReason('queue_not_accepting', err)).toBe(reason);
    },
  );

  it('reads a suspended org, which join_queue raises as its own code', () => {
    expect(refusalReason('org_suspended', new RpcError('org_suspended', 'P0001', null, 400))).toBe(
      'org_suspended',
    );
  });

  it('has nothing to say for a reason the page has no copy for', () => {
    const err = new RpcError('queue_not_accepting', 'P0001', 'something_new', 400);
    expect(refusalReason('queue_not_accepting', err)).toBeNull();
    expect(refusalReason('queue_not_accepting', new Error('queue_not_accepting'))).toBeNull();
  });

  it('has nothing to say for other failures', () => {
    const err = new RpcError('capacity_reached', 'P0001', 'paused', 400);
    expect(refusalReason('capacity_reached', err)).toBeNull();
    expect(refusalReason('rate_limited', err)).toBeNull();
  });
});
