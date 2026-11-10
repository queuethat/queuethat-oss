import { useNavigate } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';
import { supabase } from '../../lib/supabase.ts';
import { useSession } from './api.ts';

// Sent at most this often while the person is using the app. The 30 minute idle limit itself
// lives in the database (ops.end_expired_sessions); this only reports that someone is here.
const TOUCH_EVERY_MS = 60_000;
const LIVE_EVENT = 'qm:live-screen-open';

/**
 * Call from a screen people watch without touching, such as the live queue on a counter tablet:
 * while it is open and visible it counts as activity, so the 30 minute idle limit doesn't sign
 * the tablet out in a slow hour. The 12 hour limit from sign-in still applies.
 */
export function useLiveScreenActivity() {
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') window.dispatchEvent(new Event(LIVE_EVENT));
    }, TOUCH_EVERY_MS);
    return () => clearInterval(timer);
  }, []);
}

/**
 * Keeps a signed-in person's session alive while they use the app, and returns them to sign-in
 * on their next click or keypress once the database has ended it (12 hours after signing in, or
 * 30 minutes without activity). Renders nothing and does nothing while signed out. Mount once
 * per signed-in layout.
 *
 * It deliberately does not redirect the moment a session disappears: pages such as the MFA
 * lockout explain why the person was signed out, and that message must stay readable.
 */
export function SessionLimits() {
  const navigate = useNavigate();
  const signedIn = !!useSession().data;
  const had = useRef(false);
  const signedInRef = useRef(false);
  useEffect(() => {
    signedInRef.current = signedIn;
    if (signedIn) had.current = true;
  }, [signedIn]);

  useEffect(() => {
    let last = 0;
    const toSignIn = () => void navigate({ to: '/auth/sign-in' });
    const touch = () => {
      if (!signedInRef.current) {
        // The session ended while the page was open (a refresh failed): leave on first use.
        if (had.current) toSignIn();
        return;
      }
      const now = Date.now();
      if (now - last < TOUCH_EVERY_MS) return;
      last = now;
      void supabase.rpc('touch_session').then(({ error }) => {
        // not_found: the session is gone. Drop the local copy and leave.
        if (error?.message.includes('not_found')) {
          void supabase.auth.signOut({ scope: 'local' }).then(toSignIn);
        }
      });
    };
    touch();
    const events = ['pointerdown', 'keydown', LIVE_EVENT] as const;
    events.forEach((e) => window.addEventListener(e, touch, { passive: true }));
    return () => events.forEach((e) => window.removeEventListener(e, touch));
  }, [navigate]);

  return null;
}
