/**
 * localStorage key that holds the Supabase Auth session. Fixed rather than derived from the
 * project URL, so e2e sign-in (tests/e2e/support/auth.ts) does not depend on supabase-js
 * internals.
 */
export const AUTH_STORAGE_KEY = 'qm.auth';
