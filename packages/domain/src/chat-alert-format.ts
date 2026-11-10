/**
 * Staff chat alerts: turns a webhook event payload into the incoming-webhook body of Slack, Discord
 * or Microsoft Teams. Staff channels get operational facts only (ticket, queue, counts); the payload
 * never carries contact data, and a first name appears only when the endpoint opted in. Guest text is
 * escaped so it cannot mention a channel or break out of the message.
 */

export type ChatKind = 'slack' | 'discord' | 'teams';

/** The webhook payload as built by the database (api_version v1). */
export interface AlertEvent {
  id: string;
  type: string;
  occurred_at?: string;
  data?: {
    visit?: { ticket?: string; status?: string; party_size?: number; guest_first_name?: string };
    queue?: { name?: string; waiting_count?: number; state?: string; threshold?: number };
    notification?: { channel?: string; category?: string };
  };
}

export interface AlertText {
  title: string;
  body: string;
}

/** One readable sentence pair for an event; plain text, not yet escaped for any chat app. */
/** A guest's first name reduced to letters, digits, apostrophes and hyphens, so it cannot carry markdown, links or mentions. */
function safeName(name: string | undefined): string {
  return (name ?? '').replace(/[^\p{L}\p{N}'-]/gu, '').slice(0, 30);
}

export function alertText(event: AlertEvent): AlertText {
  const v = event.data?.visit;
  const q = event.data?.queue;
  const queue = q?.name ? ` in ${q.name}` : '';
  const who = v?.ticket
    ? `${v.ticket}${safeName(v.guest_first_name) ? ` (${safeName(v.guest_first_name)})` : ''}`
    : 'A guest';
  const waiting = q?.waiting_count !== undefined ? `${q.waiting_count} waiting` : '';
  switch (event.type) {
    case 'visit.joined':
      return { title: 'Guest joined', body: `${who} joined${queue}. ${waiting}`.trim() };
    case 'visit.called':
      return { title: 'Guest called', body: `${who} was called${queue}. ${waiting}`.trim() };
    case 'ping':
      return { title: 'Test alert', body: 'This is a test message from your queue.' };
    case 'queue.long':
      return {
        title: 'Queue is long',
        body: `${q?.name ?? 'A queue'} has ${q?.waiting_count ?? '?'} waiting (alert at ${q?.threshold ?? '?'}).`,
      };
    case 'queue.state_changed':
      return {
        title: 'Queue state changed',
        body: `${q?.name ?? 'A queue'} is now ${q?.state ?? 'updated'}.`,
      };
    case 'delivery.dead': {
      const n = event.data?.notification;
      return {
        title: 'Guest message failed',
        body: `A ${n?.channel ?? ''} ${n?.category ?? 'message'} could not be delivered.`.replace(
          /\s+/g,
          ' ',
        ),
      };
    }
    default:
      return {
        title: event.type,
        body: `${who} ${event.type.replace(/^visit\./, '').replace(/_/g, ' ')}${queue}.`,
      };
  }
}

/** Slack: `&`, `<` and `>` are control characters (`<!channel>`), so they are entity-escaped. */
function slackEscape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function formatSlack(event: AlertEvent): unknown {
  const { title, body } = alertText(event);
  const text = `*${slackEscape(title)}*\n${slackEscape(body)}`;
  return {
    text: `${title}: ${body}`.replace(/[<>&]/g, ''),
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }],
  };
}

export function formatDiscord(event: AlertEvent): unknown {
  const { title, body } = alertText(event);
  return {
    // No message from a guest-influenced string may ping anyone.
    allowed_mentions: { parse: [] },
    embeds: [
      {
        title,
        description: body,
        timestamp: event.occurred_at,
        color: event.type === 'delivery.dead' ? 0xd93025 : 0x1a73e8,
      },
    ],
  };
}

export function formatTeams(event: AlertEvent): unknown {
  const { title, body } = alertText(event);
  return {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.4',
          body: [
            { type: 'TextBlock', text: title, weight: 'Bolder', size: 'Medium' },
            { type: 'TextBlock', text: body, wrap: true },
          ],
        },
      },
    ],
  };
}

/** The request body for an endpoint of the given chat kind. */
export function formatChatAlert(kind: ChatKind, event: AlertEvent): unknown {
  return kind === 'slack'
    ? formatSlack(event)
    : kind === 'discord'
      ? formatDiscord(event)
      : formatTeams(event);
}
