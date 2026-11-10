import type { Database } from '@qm/db-types';
import { appConfig } from '../../lib/config.ts';
import { RpcError } from './rpcError.ts';

// The guest pages' only route to the database (#52). supabase-js is ~40 KB gzip and guests
// never sign in, so guest routes call the anon RPCs over plain fetch. Staff screens use
// lib/supabase.ts instead.

type Fns = Database['api']['Functions'];
/** Generated arg types mark every parameter required; SQL takes null for "not given". */
type Args<A> = { [K in keyof A]: A[K] | null };

/** The functions anon may execute (supabase/security-definer-allowlist.txt). */
export type GuestFn =
  | 'get_location_public'
  | 'get_location_wait'
  | 'get_location_lines'
  | 'get_visit_info'
  | 'join_queue'
  | 'get_visit_status'
  | 'guest_act'
  | 'guest_submit_feedback'
  | 'guest_add_companion'
  | 'guest_remove_companion'
  | 'guest_send_message'
  | 'guest_list_messages'
  | 'guest_register_push'
  | 'guest_grant_consent'
  | 'guest_verify_phone_code'
  | 'guest_get_alert_prefs'
  | 'guest_set_alert_prefs'
  | 'get_join_form'
  | 'set_booking_answers'
  | 'get_available_slots'
  | 'book_appointment'
  | 'get_appointment'
  | 'guest_cancel_appointment'
  | 'guest_reschedule_appointment'
  | 'guest_register_appointment_push'
  | 'guest_create_link_code'
  | 'get_location_branding'
  | 'get_location_events'
  | 'book_event_seats'
  | 'guest_join_waitlist'
  | 'guest_claim_offer'
  | 'guest_leave_waitlist'
  | 'guest_get_waitlist';

export { RpcError } from './rpcError.ts';

/**
 * Calls `api.<fn>` with PostgREST's RPC endpoint. Always POST: get_visit_status refuses GET, so
 * the token stays out of API URLs and API logs (the page path `/v/:token` still holds it). Resolves to the function's return value as typed by
 * @qm/db-types; rejects with RpcError (network failures reject with TypeError, as fetch does).
 */
export async function guestRpc<F extends GuestFn>(
  fn: F,
  args: Args<Fns[F]['Args']>,
): Promise<Fns[F]['Returns']> {
  const { supabaseUrl: url, supabaseAnonKey: key } = appConfig();
  if (!url || !key) throw new Error('VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must be set.');
  const headers: Record<string, string> = {
    apikey: key,
    'Content-Type': 'application/json',
    'Content-Profile': 'api',
    'Accept-Profile': 'api',
  };
  // Legacy JWT anon keys also go in Authorization; publishable keys must not.
  if (key.startsWith('eyJ')) headers.Authorization = `Bearer ${key}`;
  const response = await fetch(`${url}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(args),
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const err = (body ?? {}) as { message?: string; code?: string; details?: string | null };
    // A 429 without a database code is the edge's join rule (#76), so it reads as rate_limited.
    const edgeLimited = response.status === 429 && !err.code;
    throw new RpcError(
      edgeLimited ? 'rate_limited' : (err.message ?? response.statusText),
      err.code,
      err.details ?? null,
      response.status,
    );
  }
  return body as Fns[F]['Returns'];
}

/**
 * POSTs `body` to the `name` Edge Function, for the guest pages that need one (unsubscribe, join-pass).
 * Rejects with RpcError carrying the function's `error` code, or `rate_limited` for the gateway's
 * 429, like guestRpc.
 */
export async function guestFunction(
  name: 'unsubscribe' | 'join-pass',
  body: Record<string, string>,
): Promise<unknown> {
  const { supabaseUrl: url } = appConfig();
  if (!url) throw new Error('VITE_SUPABASE_URL must be set.');
  const response = await fetch(`${url}/functions/v1/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const answer = (await response.json().catch(() => null)) as { error?: string } | null;
  if (!response.ok) {
    // The gateway's 429 (#76) carries no `error` of ours.
    const code = answer?.error ?? (response.status === 429 ? 'rate_limited' : 'unknown');
    throw new RpcError(code, code, null, response.status);
  }
  return answer;
}
