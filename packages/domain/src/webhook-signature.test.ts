import { describe, expect, it } from 'vitest';
import { signWebhook, verifyWebhook } from './webhook-signature';

const now = 1_700_000_000;

describe('webhook signatures', () => {
  it('verifies a signed body', async () => {
    const header = await signWebhook('whsec_a', '{"a":1}', now);
    expect(await verifyWebhook('whsec_a', '{"a":1}', header, { now })).toBe(true);
  });

  it('fails when the body changes by one byte', async () => {
    const header = await signWebhook('whsec_a', '{"a":1}', now);
    expect(await verifyWebhook('whsec_a', '{"a":2}', header, { now })).toBe(false);
  });

  it('fails with the wrong secret and outside the tolerance', async () => {
    const header = await signWebhook('whsec_a', 'x', now);
    expect(await verifyWebhook('whsec_b', 'x', header, { now })).toBe(false);
    expect(await verifyWebhook('whsec_a', 'x', header, { now: now + 301 })).toBe(false);
    expect(await verifyWebhook('whsec_a', 'x', header, { now: now + 300 })).toBe(true);
  });

  it('accepts either secret while one is rotating out', async () => {
    const header = await signWebhook(['new', 'old'], 'x', now);
    expect(await verifyWebhook('old', 'x', header, { now })).toBe(true);
    expect(await verifyWebhook('new', 'x', header, { now })).toBe(true);
  });

  it('rejects a malformed header', async () => {
    expect(await verifyWebhook('s', 'x', 'garbage', { now })).toBe(false);
  });
});
