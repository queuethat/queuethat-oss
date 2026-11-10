import { useEffect, useRef } from 'react';

interface TurnstileApi {
  render(
    element: HTMLElement,
    options: {
      sitekey: string;
      language: string;
      callback: (token: string) => void;
      'expired-callback': () => void;
      'error-callback': () => void;
      'before-interactive-callback': () => void;
      'after-interactive-callback': () => void;
    },
  ): string;
  remove(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

/**
 * How long the widget may go without a token before the guest is told something is wrong (#576).
 * Most guests pass in a second or two, so a widget that has not answered by now is stuck. The
 * clock stops while the widget shows a challenge a person has to tick (#602), and the message
 * goes away by itself if a token still arrives.
 */
export const CHALLENGE_TIMEOUT_MS = 10_000;

const SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
let loading: Promise<TurnstileApi> | null = null;

// Loaded only where a deployment set a site key (the join page, the sign-in and sign-up pages),
// so it costs other pages nothing.
function loadTurnstile(): Promise<TurnstileApi> {
  loading ??= new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SCRIPT;
    script.async = true;
    script.onload = () =>
      window.turnstile ? resolve(window.turnstile) : reject(new Error('turnstile missing'));
    script.onerror = () => {
      loading = null; // let a later render try again
      reject(new Error('turnstile failed to load'));
    };
    document.head.append(script);
  });
  return loading;
}

/**
 * Cloudflare Turnstile in managed mode: most people see a checkmark and never solve anything.
 * Reports each fresh token, and null while there is none (loading, expired or failed). A new
 * `round` starts a new challenge, for when the server refused the last token.
 *
 * `onProblem(true)` says the guest can't expect a token soon: the script didn't load (an ad
 * blocker, a venue network that blocks Cloudflare), the widget reported an error, or
 * CHALLENGE_TIMEOUT_MS passed without one. It is `false` again once a token arrives, a new
 * challenge starts, or the widget shows a challenge for the guest to tick; it counts from that
 * challenge's end if no token follows.
 */
export function Turnstile({
  siteKey,
  language,
  round,
  label,
  onToken,
  onProblem,
}: {
  siteKey: string;
  language: string;
  round: number;
  label: string;
  onToken: (token: string | null) => void;
  onProblem: (problem: boolean) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const report = useRef(onToken);
  const problem = useRef(onProblem);
  useEffect(() => {
    report.current = onToken;
    problem.current = onProblem;
  }, [onToken, onProblem]);

  useEffect(() => {
    let widget: string | undefined;
    let gone = false;
    report.current(null);
    problem.current(false);
    let timer: ReturnType<typeof setTimeout>;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => problem.current(true), CHALLENGE_TIMEOUT_MS);
    };
    arm();
    loadTurnstile().then(
      (turnstile) => {
        if (gone || !box.current) return;
        widget = turnstile.render(box.current, {
          sitekey: siteKey,
          language,
          callback: (token) => {
            clearTimeout(timer);
            problem.current(false);
            report.current(token);
          },
          // The widget solves again by itself; if that stalls, the guest hears about it too.
          'expired-callback': () => {
            report.current(null);
            arm();
          },
          // The widget retries by itself and may still succeed, which clears this again.
          'error-callback': () => {
            report.current(null);
            problem.current(true);
          },
          // A visible challenge waits for a person, however long they take to read it.
          'before-interactive-callback': () => {
            clearTimeout(timer);
            problem.current(false);
          },
          // Once they have ticked it, the token should follow; if it doesn't, say so.
          'after-interactive-callback': arm,
        });
      },
      () => {
        if (gone) return;
        clearTimeout(timer);
        report.current(null);
        problem.current(true);
      },
    );
    return () => {
      gone = true;
      clearTimeout(timer);
      if (widget) window.turnstile?.remove(widget);
    };
  }, [siteKey, language, round]);

  return <div ref={box} role="group" aria-label={label} className="min-h-[65px]" />;
}
