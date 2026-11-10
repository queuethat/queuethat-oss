import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { supabaseEnv } from './env.ts';
import { testUsers } from './users.ts';

/** A random E.164 number no other test uses, so each test owns its guest. */
export function uniquePhone(): string {
  return `+1415${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;
}

/**
 * Makes a guest with `visits` finished-or-cancelled visits in `queueId`: staff add the same phone
 * each time (the database links them to one guest) and cancel all but the last, which stays waiting.
 */
export async function seedGuest(
  queueId: string,
  name: string,
  phone: string,
  visits: number,
): Promise<void> {
  const env = supabaseEnv();
  const client = createClient(env.url, env.anonKey, { auth: { persistSession: false } });
  const { error: signInError } = await client.auth.signInWithPassword(testUsers.staff);
  if (signInError) throw signInError;
  const api = client.schema('api');
  for (let i = 0; i < visits; i++) {
    const added = await api.rpc('staff_add_visit', {
      p_queue_id: queueId,
      p_service_id: null as unknown as string,
      p_name: name,
      p_phone_e164: phone,
      p_party_size: 1,
      p_idempotency_key: randomUUID(),
    });
    if (added.error) throw added.error;
    if (i === visits - 1) break;
    const visit = added.data as { id: string; version: number };
    const done = await api.rpc('transition_visit', {
      p_visit_id: visit.id,
      p_action: 'cancel',
      p_expected_version: visit.version,
      p_idempotency_key: randomUUID(),
    });
    if (done.error) throw done.error;
  }
}

/** One staff add of `phone`; resolves with the error code (e.g. `guest_blocked`) or null when it worked. */
export async function tryStaffAdd(
  queueId: string,
  name: string,
  phone: string,
): Promise<string | null> {
  const env = supabaseEnv();
  const client = createClient(env.url, env.anonKey, { auth: { persistSession: false } });
  const { error: signInError } = await client.auth.signInWithPassword(testUsers.staff);
  if (signInError) throw signInError;
  const { error } = await client.schema('api').rpc('staff_add_visit', {
    p_queue_id: queueId,
    p_service_id: null as unknown as string,
    p_name: name,
    p_phone_e164: phone,
    p_party_size: 1,
    p_idempotency_key: randomUUID(),
  });
  return error ? error.message : null;
}
