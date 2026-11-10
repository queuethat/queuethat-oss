import type { Database } from '@qm/db-types';
import { createClient } from '@supabase/supabase-js';
import { AUTH_STORAGE_KEY } from './auth-storage.ts';
import { appConfig } from './config.ts';
import { clearOperator, getOperatorToken } from '../features/operator/session.ts';

const { supabaseUrl: url, supabaseAnonKey: anonKey } = appConfig();

if (!url || !anonKey) {
  throw new Error(
    'VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must be set. Copy apps/web/.env.example to apps/web/.env.local.',
  );
}

/**
 * While a colleague is switched in on this tablet (2A-TM5), database calls carry their token as
 * `x-operator-token`. The database rejects a dead token with `operator_session_invalid`; the token
 * is dropped here so the tablet falls back to its own account instead of failing every call.
 */
async function fetchAsOperator(input: RequestInfo | URL, init?: RequestInit) {
  const token = getOperatorToken();
  const isDatabase = (
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  ).includes('/rest/v1/');
  if (!token || !isDatabase) return fetch(input, init);
  const headers = new Headers(init?.headers);
  headers.set('x-operator-token', token);
  const response = await fetch(input, { ...init, headers });
  if (!response.ok && response.status < 500) {
    const body = await response
      .clone()
      .text()
      .catch(() => '');
    if (body.includes('operator_session_invalid')) clearOperator();
  }
  return response;
}

/**
 * Typed Supabase client. `rpc()` targets the `api` schema by default, which is the only
 * write path for visits and queues. Config tables are read and written with
 * `supabase.schema('app').from(...)` under RLS.
 */
export const supabase = createClient<Database, 'api'>(url, anonKey, {
  db: { schema: 'api' },
  global: { fetch: fetchAsOperator },
  auth: {
    storageKey: AUTH_STORAGE_KEY,
    // PKCE: an emailed link carries a one-time code that only the browser which asked for it can
    // exchange, so tokens never sit in the URL or history and a crafted link can't swap accounts.
    flowType: 'pkce',
  },
});
