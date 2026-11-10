/** The guest's status page for a link token, as printed in a ticket's QR. Null without a token. */
export function statusUrl(origin: string, token: string | null | undefined): string | null {
  return token ? `${origin}/v/${token}` : null;
}
