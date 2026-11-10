// 4-INT1 (#395): Square events. Registered under `square` in index.ts. Signature check and event-id
// de-duplication already happened in provider-webhook. The only event that matters is the seller
// revoking the app: the tokens are dead, so the connection is switched off (api.revoke_integration).
import type { WebhookHandler } from '../handler.ts';

export type RevokeIntegration = (orgId: string, merchantId: string | null) => Promise<void>;

export function squareHandler(revoke: RevokeIntegration): WebhookHandler {
  return async ({ orgId, rawBody }) => {
    if (!orgId) return;
    let event: { type?: unknown; merchant_id?: unknown };
    try {
      event = JSON.parse(new TextDecoder().decode(rawBody));
    } catch {
      return;
    }
    if (event.type === 'oauth.authorization.revoked') {
      // Square names the merchant; the database ignores an event about a merchant this connection is not.
      await revoke(orgId, typeof event.merchant_id === 'string' ? event.merchant_id : null);
    }
  };
}
