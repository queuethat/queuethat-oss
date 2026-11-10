import { eventually } from './poll.ts';

/** The local stack's mail catcher (Mailpit, `[inbucket] port` in supabase/config.toml). */
export const MAILPIT_URL = process.env.E2E_MAILPIT_URL ?? 'http://127.0.0.1:55324';

interface MessageSummary {
  ID: string;
  Created: string;
}

/**
 * Waits for the first email to `to` that arrived after `since` and returns its HTML. Give every
 * test its own address so parallel projects never read each other's mail.
 */
export async function authEmailFor(to: string, since: Date): Promise<string> {
  let html: string | undefined;
  await eventually(async () => {
    const query = encodeURIComponent(`to:"${to}"`);
    const response = await fetch(`${MAILPIT_URL}/api/v1/search?query=${query}`);
    if (!response.ok) return undefined;
    const { messages } = (await response.json()) as { messages: MessageSummary[] };
    const fresh = messages.find((m) => new Date(m.Created) >= since);
    if (!fresh) return undefined;
    const message = (await (await fetch(`${MAILPIT_URL}/api/v1/message/${fresh.ID}`)).json()) as {
      HTML: string;
    };
    html = message.HTML;
    return html;
  }, `no auth email for ${to}`).toBeTruthy();
  return html!;
}

/** The Supabase Auth link in the first email to `to` after `since`. */
export async function authLinkFor(to: string, since: Date): Promise<string> {
  const link = /href="([^"]*\/auth\/v1\/verify[^"]*)"/.exec(await authEmailFor(to, since))?.[1];
  if (!link) throw new Error(`The auth email to ${to} has no link.`);
  return link.replaceAll('&amp;', '&');
}

/** The 8-digit code in the first email to `to` after `since`. */
export async function authCodeFor(to: string, since: Date): Promise<string> {
  const code = />\s*(\d{8})\s*</.exec(await authEmailFor(to, since))?.[1];
  if (!code) throw new Error(`The auth email to ${to} has no code.`);
  return code;
}

/** A fresh address per call, so tests and device projects never share an inbox. */
export function uniqueEmail(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@e2e.test`;
}
