import { describe, expect, it } from 'vitest';
import { alertText, formatChatAlert, type AlertEvent } from './chat-alert-format';

const joined: AlertEvent = {
  id: 'v:1',
  type: 'visit.joined',
  occurred_at: '2026-10-30T12:00:00Z',
  data: { visit: { ticket: 'A012', party_size: 2 }, queue: { name: 'Walk-ins', waiting_count: 5 } },
};
const long: AlertEvent = {
  id: 'ql:1',
  type: 'queue.long',
  data: { queue: { name: 'Walk-ins', waiting_count: 11, threshold: 10 } },
};

describe('chat alert formats', () => {
  it('writes operational text only', () => {
    expect(alertText(joined)).toEqual({
      title: 'Guest joined',
      body: 'A012 joined in Walk-ins. 5 waiting',
    });
    expect(alertText(long).body).toBe('Walk-ins has 11 waiting (alert at 10).');
  });

  it('formats Slack Block Kit', () => {
    expect(formatChatAlert('slack', joined)).toMatchInlineSnapshot(`
      {
        "blocks": [
          {
            "text": {
              "text": "*Guest joined*
      A012 joined in Walk-ins. 5 waiting",
              "type": "mrkdwn",
            },
            "type": "section",
          },
        ],
        "text": "Guest joined: A012 joined in Walk-ins. 5 waiting",
      }
    `);
  });

  it('formats a Discord embed that mentions nobody', () => {
    const body = formatChatAlert('discord', long) as {
      allowed_mentions: unknown;
      embeds: { title: string }[];
    };
    expect(body.allowed_mentions).toEqual({ parse: [] });
    expect(body.embeds[0]!.title).toBe('Queue is long');
  });

  it('formats a Teams adaptive card', () => {
    const body = formatChatAlert('teams', long) as {
      attachments: { contentType: string; content: { body: { text: string }[] } }[];
    };
    expect(body.attachments[0]!.contentType).toBe('application/vnd.microsoft.card.adaptive');
    expect(body.attachments[0]!.content.body[1]!.text).toContain('11 waiting');
  });

  it('reduces a guest name to plain characters so it cannot ping, link or format', () => {
    for (const name of [
      '<!channel>',
      '[Verify](https://evil.example/login)',
      '**bold**',
      '@everyone',
    ]) {
      const evil: AlertEvent = {
        ...joined,
        data: { ...joined.data, visit: { ticket: 'A1', guest_first_name: name } },
      };
      for (const kind of ['slack', 'discord', 'teams'] as const) {
        const out = JSON.stringify(formatChatAlert(kind, evil));
        expect(out).not.toMatch(/evil\.example|\]\(|@everyone|<!channel>|\*\*bold/);
      }
    }
  });

  it('never carries contact data it was not given', () => {
    for (const kind of ['slack', 'discord', 'teams'] as const) {
      const out = JSON.stringify(formatChatAlert(kind, joined));
      expect(out).not.toMatch(/phone|email|@/i);
    }
  });
});
