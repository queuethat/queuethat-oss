// Shared by the status page and the service worker (src/sw.ts): what a push shows and where tapping
// it goes. Pure, so it is unit-tested without a worker.

/** Cache Storage entry holding the token of the visit this browser last turned alerts on for. */
export const PUSH_CACHE = 'qm-push';
export const PUSH_VISIT_KEY = '/__qm/push-visit';

/** Matches the web manifest name; the worker has no translations. */
const APP_NAME = 'QueueThat';

export interface PushNotice {
  title: string;
  body: string;
  /** The dispatcher always sends 'visit', so a newer alert replaces an older one. */
  tag: string;
  /** Same-origin path the dispatcher asked for, if any. */
  url: string | null;
}

/**
 * The notification to show for a push. Browsers require one for every push (userVisibleOnly), so
 * a payload that isn't the dispatcher's JSON (packages/providers PushPayload) still shows one.
 */
export function noticeFor(data: string | null): PushNotice {
  let p: Record<string, unknown> = {};
  try {
    const parsed: unknown = data ? JSON.parse(data) : null;
    if (parsed && typeof parsed === 'object') p = parsed as Record<string, unknown>;
  } catch {
    // not JSON: shown as plain text below
  }
  const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const body = text(p.body) || (Object.keys(p).length ? '' : text(data));
  return {
    title: text(p.title) || APP_NAME,
    body,
    tag: text(p.tag) || 'visit',
    url: text(p.url) || null,
  };
}

export type ClickAction = { focus: number } | { open: string };

/**
 * Where tapping a notification goes: the status page the push names, else the one this browser
 * turned alerts on for, else any open status page, else the home page. An open window already
 * showing the target is focused instead of opening a second one. Paths from the push are used
 * only when same-origin and under /v/ or /a/ (a reminder opens the appointment page), so a payload can't send the guest elsewhere.
 */
export function clickAction(
  pushUrl: string | null,
  storedToken: string | null,
  windowUrls: readonly string[],
  origin: string,
): ClickAction {
  const paths = windowUrls.map((u) => pathOf(u, origin));
  let target: string | null = null;
  const fromPush = pushUrl ? pathOf(pushUrl, origin) : null;
  if (fromPush?.startsWith('/v/') || fromPush?.startsWith('/a/')) target = fromPush;
  else if (storedToken) target = `/v/${encodeURIComponent(storedToken)}`;

  if (target) {
    const open = paths.indexOf(target);
    return open >= 0 ? { focus: open } : { open: target };
  }
  const anyStatus = paths.findIndex((p) => p?.startsWith('/v/') || p?.startsWith('/a/'));
  return anyStatus >= 0 ? { focus: anyStatus } : { open: '/' };
}

/** The path of a same-origin URL, or null. */
function pathOf(url: string, origin: string): string | null {
  try {
    const u = new URL(url, origin);
    return u.origin === origin ? u.pathname : null;
  } catch {
    return null;
  }
}
