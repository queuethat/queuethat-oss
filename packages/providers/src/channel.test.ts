import { describe, expect, it } from 'vitest';
import { createRegistry, defineChannel } from './channel.ts';
import { consoleChannel } from './console.ts';
import { zoneAtLocalHour } from './contract.ts';

const write = async () => {};

describe('createRegistry', () => {
  it('returns the channel registered for a kind, or null', async () => {
    const sms = consoleChannel({ write, kind: 'sms' });
    const registry = createRegistry([consoleChannel({ write }), sms]);
    expect(await registry.get('org-1', 'sms')).toBe(sms);
    expect(await registry.get('org-1', 'whatsapp')).toBeNull();
  });

  it('rejects two channels for one kind', () => {
    expect(() => createRegistry([consoleChannel({ write }), consoleChannel({ write })])).toThrow(
      /console/,
    );
  });
});

describe('defineChannel', () => {
  const msg = {
    outboxId: 'n-1',
    orgId: 'org-1',
    channel: 'sms' as const,
    category: 'transactional' as const,
    trigger: 'called' as const,
    to: { kind: 'address' as const, value: '+14155550123' },
    text: 'hi',
    policy: { hasConsent: true, isSuppressed: false, locationTz: zoneAtLocalHour(12) },
  };

  it('turns a provider exception into a retryable failure', async () => {
    const channel = defineChannel({
      kind: 'sms',
      providerName: 'flaky',
      deliver: async () => {
        throw new Error('socket hang up');
      },
    });
    expect(await channel.send(msg)).toMatchObject({
      status: 'failed',
      retryable: true,
      code: 'provider_exception',
    });
  });
});
