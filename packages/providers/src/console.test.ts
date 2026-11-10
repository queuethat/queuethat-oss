import { describe, expect, it } from 'vitest';
import { consoleChannel, type DevInboxRow } from './console.ts';
import { runChannelContract, zoneAtLocalHour } from './contract.ts';

function harness(kind: 'console' | 'sms' = 'console') {
  const inbox: DevInboxRow[] = [];
  let broken = false;
  const channel = consoleChannel({
    kind,
    write: async (row) => {
      if (broken) {
        broken = false;
        throw new Error('connection refused');
      }
      inbox.push(row);
    },
  });
  return {
    inbox,
    channel,
    to: { kind: 'address' as const, value: '+14155550123' },
    delivered: async () => inbox.map((row) => ({ text: row.body })),
    breakNext: () => {
      broken = true;
    },
  };
}

runChannelContract('console', () => harness());
runChannelContract('console standing in for sms', () => harness('sms'));

describe('consoleChannel', () => {
  // Acceptance criterion 1 (#67).
  it('suppresses a contact without consent and writes nothing to dev_inbox', async () => {
    const h = harness();
    const result = await h.channel.send({
      outboxId: '00000000-0000-0000-0000-000000000001',
      orgId: '00000000-0000-0000-0000-0000000000aa',
      channel: 'console',
      category: 'transactional',
      trigger: 'called',
      to: h.to,
      text: "It's your turn: A012.",
      policy: { hasConsent: false, isSuppressed: false, locationTz: zoneAtLocalHour(12) },
    });
    expect(result).toEqual({ status: 'suppressed', reason: 'no_consent' });
    expect(h.inbox).toEqual([]);
  });

  it('writes a dev_inbox row linked to the notification', async () => {
    const h = harness('sms');
    await h.channel.send({
      outboxId: 'n-1',
      orgId: 'org-1',
      channel: 'sms',
      category: 'transactional',
      trigger: 'called',
      to: h.to,
      text: "It's your turn: A012.",
      url: 'http://localhost:5173/v/tok',
      policy: { hasConsent: true, isSuppressed: false, locationTz: 'UTC' },
    });
    expect(h.inbox).toEqual([
      {
        org_id: 'org-1',
        notification_id: 'n-1',
        channel: 'sms',
        recipient: '+14155550123',
        subject: null,
        body: "It's your turn: A012.\nhttp://localhost:5173/v/tok",
      },
    ]);
  });

  it('records the encoding and segment count when it is given a counter', async () => {
    const inbox: DevInboxRow[] = [];
    const channel = consoleChannel({
      kind: 'sms',
      segments: (text) => ({ encoding: text.includes('é') ? 'gsm7' : 'ucs2', segments: 2 }),
      write: async (row) => void inbox.push(row),
    });
    const result = await channel.send({
      outboxId: 'n-2',
      orgId: 'org-1',
      channel: 'sms',
      category: 'transactional',
      trigger: 'help',
      to: { kind: 'address', value: '+14155550123' },
      text: 'é',
      policy: { hasConsent: true, isSuppressed: false, locationTz: zoneAtLocalHour(12) },
    });
    expect(result).toMatchObject({ status: 'sent', segments: 2, costMicros: 0 });
    expect(inbox[0]).toMatchObject({ encoding: 'gsm7', segments: 2 });
  });
});
