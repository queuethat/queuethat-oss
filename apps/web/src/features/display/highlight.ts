/** How long a newly called ticket stays highlighted on the TV. */
export const HIGHLIGHT_MS = 10_000;

/**
 * One call of one ticket. api.display_snapshot sets `called_at` to the ticket's latest call or
 * recall that was not undone, so a recall makes a new key and highlights again (#529).
 */
export function callKey(ticket: { display_ticket: string | null; called_at: string | null }) {
  return `${ticket.display_ticket}@${ticket.called_at}`;
}

/**
 * Which calls to highlight, given the calls the screen had already seen (`seen`, or null before
 * its first data) and the calls it holds now. Calls already on screen at load never flash, so a
 * TV that reloads doesn't announce the whole room again.
 */
export function newCalls(seen: ReadonlySet<string> | null, current: readonly string[]): string[] {
  if (seen === null) return [];
  return current.filter((key) => !seen.has(key));
}
