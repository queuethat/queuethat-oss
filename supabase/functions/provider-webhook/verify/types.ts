// A verifier proves a request came from the provider and names the events it carries. It never
// touches the database. Signatures cover the raw bytes and the configured public URL, never Host.
export interface WebhookRequest {
  rawBody: Uint8Array;
  headers: Headers;
  /** PUBLIC_FUNCTIONS_URL + the route, as the provider was told to call it. */
  publicUrl: string;
  /** Parsed body when it is application/x-www-form-urlencoded (Twilio). */
  form?: URLSearchParams;
}

export type VerifyResult = { ok: true } | { ok: false; reason: 'missing' | 'mismatch' | 'stale' };

export interface WebhookVerifier {
  provider: 'twilio' | 'stripe' | 'meta' | string;
  /** The provider name the endpoint's secrets are stored under, when it differs from the route's (Twilio Voice shares Twilio's token). */
  secretsProvider?: string;
  /** The handler's reply is the HTTP response (TwiML), and a replayed request is answered again. */
  inlineResponse?: boolean;
  /** The body sent when an inline handler fails or does not run. */
  failureReply?: string;
  /** `secret` is one candidate; the caller tries each secret of the endpoint (rotation). */
  verify(req: WebhookRequest, secret: string, now: Date): Promise<VerifyResult>;
  /** Idempotency keys of the events in the body, in order. Empty when the body holds none. */
  eventKeys(rawBody: Uint8Array, form?: URLSearchParams, headers?: Headers): string[];
}
