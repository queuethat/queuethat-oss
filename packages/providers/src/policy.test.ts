import { describe, expect, it } from 'vitest';
import type { OutboundMessage } from './channel.ts';
import { policyCheck } from './policy.ts';

function msg(overrides: Partial<OutboundMessage> = {}): OutboundMessage {
  return {
    outboxId: 'n1',
    orgId: 'o1',
    channel: 'sms',
    category: 'transactional',
    trigger: 'almost_up',
    to: { kind: 'address', value: '+14155550123' },
    text: 'hi',
    policy: { hasConsent: true, isSuppressed: false, locationTz: 'America/New_York' },
    ...overrides,
  };
}
const withPolicy = (p: Partial<OutboundMessage['policy']>) =>
  msg({ policy: { ...msg().policy, ...p } });

describe('policyCheck', () => {
  it('sends a consenting, unsuppressed message', () => {
    expect(policyCheck(msg())).toBeNull();
  });

  it('requires consent', () => {
    expect(policyCheck(withPolicy({ hasConsent: false }))).toBe('no_consent');
  });

  it('names a missing marketing consent, so transactional consent alone never sends marketing', () => {
    expect(
      policyCheck(msg({ category: 'marketing', policy: { ...msg().policy, hasConsent: false } })),
    ).toBe('no_marketing_consent');
    expect(policyCheck(msg({ category: 'marketing' }))).toBeNull();
  });

  it('blocks suppressed addresses even with consent', () => {
    expect(policyCheck(withPolicy({ isSuppressed: true }))).toBe('suppressed');
  });

  it('checks account mail (no location zone) for consent too', () => {
    expect(policyCheck(withPolicy({ locationTz: null }))).toBeNull();
    expect(policyCheck(withPolicy({ locationTz: null, hasConsent: false }))).toBe('no_consent');
  });

  it('does not derive the send window: the database decides, whatever the clock says', () => {
    // 03:00 in New York. Rows outside the window never reach a channel (api.claim_outbox).
    expect(policyCheck(msg({ trigger: 'almost_up' }))).toBeNull();
    expect(policyCheck(withPolicy({ locationTz: 'Mars/Olympus' }))).toBeNull();
  });

  it('still needs consent for web push', () => {
    const push = msg({
      channel: 'push',
      to: { kind: 'push', endpoint: 'https://x', p256dh: 'p', auth: 'a' },
    });
    expect(policyCheck(push)).toBeNull();
    expect(policyCheck({ ...push, policy: { ...push.policy, hasConsent: false } })).toBe(
      'no_consent',
    );
  });
});
