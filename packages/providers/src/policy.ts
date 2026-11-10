// Send policy shared by every channel (technical-design.md 6). Runs inside defineChannel, so local
// providers enforce exactly what paid ones will.
import type { OutboundMessage } from './channel.ts';

export type SuppressReason = 'no_consent' | 'no_marketing_consent' | 'suppressed';

/**
 * Returns why `msg` must not be sent, or null when it may be sent.
 *
 * The send window (quiet hours) is deliberately not checked here: `api.claim_outbox` owns it
 * (`private.send_window_open`) and never hands the dispatcher a row outside its window, so a second
 * derivation in TypeScript could only disagree with it.
 */
export function policyCheck(msg: OutboundMessage): SuppressReason | null {
  // hasConsent is for the message's own category, so marketing needs a granted marketing consent.
  if (!msg.policy.hasConsent)
    return msg.category === 'marketing' ? 'no_marketing_consent' : 'no_consent';
  if (msg.policy.isSuppressed) return 'suppressed';
  return null;
}
