import { createClient } from '@supabase/supabase-js';
import { DEMO_PASSWORD, demo } from '../../fixtures/demo.ts';
import { supabaseEnv } from './env.ts';
import { uniqueEmail } from './mail.ts';

/** A throwaway member of the demo org, created with the service role. Optionally gets an operator PIN. */
export async function createMember(
  name: string,
  options: { pin?: string; role?: 'staff' | 'manager' | 'admin' } = {},
) {
  const { anonKey, serviceRoleKey, url } = supabaseEnv();
  const admin = createClient(url, serviceRoleKey, { auth: { persistSession: false } });
  const email = uniqueEmail('team');
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: DEMO_PASSWORD,
    email_confirm: true,
  });
  if (error) throw error;
  const { error: insert } = await admin
    .schema('app')
    .from('memberships')
    .insert({
      org_id: demo.orgId,
      user_id: data.user.id,
      role: options.role ?? 'staff',
      display_name: name,
    });
  if (insert) throw insert;
  if (options.pin) {
    // The member sets their own PIN, the way the app does.
    const own = createClient(url, anonKey, { auth: { persistSession: false } });
    await own.auth.signInWithPassword({ email, password: DEMO_PASSWORD });
    const { error: pinError } = await own.schema('api').rpc('set_my_pin', {
      p_org_id: demo.orgId,
      p_pin: options.pin,
    });
    if (pinError) throw pinError;
  }
  return { email, userId: data.user.id };
}
