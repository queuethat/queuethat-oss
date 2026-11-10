// Shared contract every NotificationChannel must pass (architecture review 6). Runs against
// fakes in CI and, from phase 3, against real provider sandboxes. Import from
// '@qm/providers/contract' in a *.test.ts file; it needs Vitest, so it is not in the main entry.
import { describe, expect, it } from 'vitest';
import type { NotificationChannel, OutboundMessage, Recipient } from './channel.ts';

export interface ChannelHarness {
  channel: NotificationChannel;
  /** A recipient this channel can deliver to. */
  to: Recipient;
  /** What actually got delivered, read back from wherever the provider delivers. */
  delivered(): Promise<Array<{ text: string }>>;
  /** Makes the next delivery fail in transport (network down, 503). Omit if not possible. */
  breakNext?(): void;
}

/** An IANA zone whose local hour is `hour` right now, so tests need no fake clock. */
export function zoneAtLocalHour(hour: number, now = new Date()): string {
  const offset = ((((hour - now.getUTCHours()) % 24) + 24 + 12) % 24) - 12; // -12..11
  // Etc/GMT names have the sign inverted: Etc/GMT-3 is UTC+3.
  return offset === 0 ? 'Etc/GMT' : `Etc/GMT${offset > 0 ? '-' : '+'}${Math.abs(offset)}`;
}

/** Runs the contract suite for one provider. `factory` must return a fresh, empty harness. */
export function runChannelContract(
  name: string,
  factory: () => ChannelHarness | Promise<ChannelHarness>,
): void {
  function message(h: ChannelHarness, overrides: Partial<OutboundMessage> = {}): OutboundMessage {
    const outboxId = crypto.randomUUID();
    return {
      outboxId,
      orgId: crypto.randomUUID(),
      channel: h.channel.kind,
      category: 'transactional',
      trigger: 'almost_up',
      to: h.to,
      subject: 'Almost up',
      text: `You're almost up (A012). ref ${outboxId}`,
      policy: { hasConsent: true, isSuppressed: false, locationTz: zoneAtLocalHour(12) },
      ...overrides,
    };
  }

  async function expectNothingDelivered(h: ChannelHarness) {
    expect(await h.delivered()).toEqual([]);
  }

  describe(`NotificationChannel contract: ${name}`, () => {
    it('names its channel kind and provider', async () => {
      const h = await factory();
      expect(h.channel.kind).toMatch(/^[a-z]+$/);
      expect(h.channel.providerName).toMatch(/^[a-z0-9-]+$/);
    });

    it('delivers an allowed message once and reports sent', async () => {
      const h = await factory();
      const msg = message(h);
      expect(await h.channel.send(msg)).toMatchObject({ status: 'sent' });
      const delivered = await h.delivered();
      expect(delivered).toHaveLength(1);
      expect(delivered[0]?.text).toContain(msg.text);
    });

    it('suppresses a recipient without consent and delivers nothing', async () => {
      const h = await factory();
      const msg = message(h, { policy: { ...message(h).policy, hasConsent: false } });
      expect(await h.channel.send(msg)).toEqual({ status: 'suppressed', reason: 'no_consent' });
      await expectNothingDelivered(h);
    });

    it('suppresses a suppressed address and delivers nothing', async () => {
      const h = await factory();
      const msg = message(h, { policy: { ...message(h).policy, isSuppressed: true } });
      expect(await h.channel.send(msg)).toEqual({ status: 'suppressed', reason: 'suppressed' });
      await expectNothingDelivered(h);
    });

    it('estimates without delivering', async () => {
      const h = await factory();
      const estimate = h.channel.estimate(message(h));
      expect(estimate.costMicros ?? 0).toBeGreaterThanOrEqual(0);
      expect(estimate.segments ?? 1).toBeGreaterThanOrEqual(1);
      await expectNothingDelivered(h);
    });

    it('refuses a message for another channel', async () => {
      const h = await factory();
      const other = h.channel.kind === 'email' ? 'sms' : 'email';
      expect(await h.channel.send(message(h, { channel: other }))).toMatchObject({
        status: 'failed',
        retryable: false,
      });
      await expectNothingDelivered(h);
    });

    it('returns a retryable failure instead of throwing when transport breaks', async (ctx) => {
      const h = await factory();
      if (!h.breakNext) return ctx.skip();
      h.breakNext();
      expect(await h.channel.send(message(h))).toMatchObject({ status: 'failed', retryable: true });
      await expectNothingDelivered(h);
    });
  });
}
