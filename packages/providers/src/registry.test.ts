import { describe, expect, it, vi } from 'vitest';
import { createRegistry, defineChannel } from './channel.ts';
import type { ChannelKind } from './channel.ts';
import { DbChannelRegistry, localProvidersOnly, type ChannelConfig } from './registry.ts';

const fake = (kind: ChannelKind, providerName: string) =>
  defineChannel({ kind, providerName, deliver: () => Promise.resolve({ status: 'sent' }) });

const twilioRow: ChannelConfig = {
  provider: 'twilio',
  mode: 'own',
  config: { from_number: '+15005550006' },
  secrets: { auth_token: 'tok_secret_1234' },
  enabled: true,
};
const off: ChannelConfig = {
  provider: null,
  mode: null,
  config: null,
  secrets: null,
  enabled: false,
};

function setup(over: { localOnly?: boolean; rows?: Record<string, ChannelConfig> } = {}) {
  const fetchConfig = vi.fn((orgId: string) => Promise.resolve(over.rows?.[orgId] ?? off));
  const registry = new DbChannelRegistry({
    fetchConfig,
    factories: { twilio: () => fake('sms', 'twilio') },
    local: createRegistry([fake('sms', 'console'), fake('push', 'vapid')]),
    localOnly: over.localOnly ?? false,
  });
  return { registry, fetchConfig };
}

describe('DbChannelRegistry', () => {
  it('AC1: gives an org with enabled settings its own provider and an org without none', async () => {
    const { registry } = setup({ rows: { a: twilioRow } });
    expect((await registry.get('a', 'sms'))?.providerName).toBe('twilio');
    expect(await registry.get('b', 'sms')).toBeNull();
    expect(registry.missingReason('b', 'sms')).toBe('channel_disabled');
    expect(registry.missingReason('b', 'push')).toBeUndefined();
    expect(setup({ localOnly: true }).registry.missingReason('b', 'sms')).toBeUndefined();
  });

  it('AC2: LOCAL_PROVIDERS_ONLY forces the local channel for every org and never reads settings', async () => {
    const { registry, fetchConfig } = setup({ localOnly: true, rows: { a: twilioRow } });
    expect((await registry.get('a', 'sms'))?.providerName).toBe('console');
    expect((await registry.get('b', 'sms'))?.providerName).toBe('console');
    expect(fetchConfig).not.toHaveBeenCalled();
  });

  it('defaults to local providers unless LOCAL_PROVIDERS_ONLY is exactly false', () => {
    expect([undefined, '', 'true', '0'].map(localProvidersOnly)).toEqual([true, true, true, true]);
    expect(localProvidersOnly('false')).toBe(false);
  });

  it('reads settings once per org and kind', async () => {
    const { registry, fetchConfig } = setup({ rows: { a: twilioRow } });
    await Promise.all([
      registry.get('a', 'sms'),
      registry.get('a', 'sms'),
      registry.get('a', 'sms'),
    ]);
    expect(fetchConfig).toHaveBeenCalledTimes(1);
  });

  it('leaves deployment channels such as push to the local registry', async () => {
    const { registry, fetchConfig } = setup();
    expect((await registry.get('a', 'push'))?.providerName).toBe('vapid');
    expect(fetchConfig).not.toHaveBeenCalled();
  });

  it('returns null for an unknown provider or a channel of the wrong kind', async () => {
    const { registry } = setup({ rows: { a: { ...twilioRow, provider: 'nope' }, b: twilioRow } });
    expect(await registry.get('a', 'sms')).toBeNull();
    expect(await registry.get('b', 'whatsapp')).toBeNull();
  });

  it('keeps secrets and numbers out of the error a failing factory leaves behind', async () => {
    const registry = new DbChannelRegistry({
      fetchConfig: () => Promise.resolve(twilioRow),
      factories: {
        twilio: (s) => {
          throw new Error(`bad token ${s.secrets.auth_token} for ${s.config.from_number}`);
        },
      },
      local: createRegistry([]),
      localOnly: false,
    });
    const err = await registry.get('a', 'sms').catch((e: Error) => e);
    expect(String(err)).toBe('Error: provider_factory_failed:twilio');
    expect(String(err)).not.toMatch(/tok_secret|5550006/);
  });
});
