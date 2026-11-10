/**
 * The operator session on this tablet (2A-TM5, #99). The token lives in sessionStorage so a reload
 * keeps the lock state but closing the tab ends it; it is never written anywhere else. This module
 * has no Supabase import: lib/supabase.ts reads it to add the `x-operator-token` header.
 */
export interface OperatorSession {
  token: string;
  userId: string;
  displayName: string | null;
  role: string;
  expiresAt: string;
}

const KEY = 'qm-operator-session';
const listeners = new Set<() => void>();
let cached: OperatorSession | null | undefined;

function read(): OperatorSession | null {
  if (cached !== undefined) return cached;
  try {
    const raw = window.sessionStorage.getItem(KEY);
    cached = raw ? (JSON.parse(raw) as OperatorSession) : null;
  } catch {
    cached = null;
  }
  if (cached && Date.parse(cached.expiresAt) <= Date.now()) cached = null;
  return cached;
}

/** The active operator, or null when the tablet runs as its own signed-in account. */
export const getOperator = read;

/** The token to send as `x-operator-token`, if any. */
export const getOperatorToken = () => read()?.token ?? null;

/** Starts working as `session`. */
export function setOperator(session: OperatorSession) {
  cached = session;
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(session));
  } catch {
    // Private mode: the session lasts until reload.
  }
  listeners.forEach((notify) => notify());
}

/** Drops the token locally. The server-side session is ended by `useLock`. */
export function clearOperator() {
  if (read() === null && cached !== undefined) return;
  cached = null;
  try {
    window.sessionStorage.removeItem(KEY);
  } catch {
    // Nothing stored to remove.
  }
  listeners.forEach((notify) => notify());
}

export function subscribeOperator(notify: () => void) {
  listeners.add(notify);
  return () => listeners.delete(notify);
}
