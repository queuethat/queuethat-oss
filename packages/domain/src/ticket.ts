/**
 * Formats a ticket for display, e.g. ("A", 7) -> "A007".
 * Numbers above 999 are shown in full rather than truncated.
 */
export function formatTicket(prefix: string, ticketNumber: number): string {
  return `${prefix}${String(ticketNumber).padStart(3, '0')}`;
}
