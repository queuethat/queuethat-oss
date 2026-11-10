import { errorCode } from './errors.ts';

// O6 (#77): what may leave the app in an error report or a log line (I-7, I-13). Shared by the
// web app's Sentry setup and the Edge Functions, so both scrub the same things.

// Anchored at the start of the local part, so a long run of word characters stays linear.
const EMAIL = /(?<![\w.+-])[\w.+-]+@(?:[\w-]+\.)+[a-z]{2,}\b/gi;
// E.164 and national formats: 9 to 15 digits, optionally led by +, with spaces, dots, dashes or
// brackets between. Dates (8 digits), date-times, ports and UUID groups don't qualify.
const PHONE = /(?<![\w.-]|\d:)\+?\(?\d(?:[\s().-]*\d){8,14}(?![\w-]|:\d)/g;
const JWT = /\beyJ[\w-]+\.[\w-]+\.[\w-]+/g;
// A guest's status link (/v/<token>), appointment link (/a/<token>) and unsubscribe link (/u?...)
// are bearer secrets.
const GUEST_LINK = /\/([va])\/[\w-]+/g;
// Guest tokens, device keys and refresh tokens are 32+ random bytes in base64url: 43+ characters.
const BARE_SECRET = /(?<![\w-])[\w-]{43,}(?![\w-])/g;
// Percent-encoded separators, so `%2B44…` and `%2Fv%2F…` are seen like their decoded forms.
const ENCODED = /%(2B|2F|40|20)/gi;
const DECODED: Record<string, string> = { '2b': '+', '2f': '/', '40': '@', '20': ' ' };
const SECRET_PARAM =
  /([?&#](?:token|t|code|access_token|refresh_token|provider_token|apikey|key|sig)=)[^&#\s"']*/gi;

/**
 * Keys whose values are dropped wherever they appear, whatever they hold: contact fields, any
 * `*token`, `*_key` or `*_name` (RPC params like `p_token`, `p_device_key`, `p_name`) and
 * credentials, including a push subscription's `endpoint`, `p256dh` and `auth`. Bare `name` and `key` stay, because the SDK's own metadata uses them.
 */
const SECRET_KEY =
  /(?:^|_)(?:email|phone|contact|recipient|password|secret)(?:_|$)|token$|(?<!public)_key$|_name$|^(?:authorization|cookie|apikey|x-client-info|name_on_ticket|auth|p256dh|endpoint)$/i;

/**
 * Replaces email addresses, phone numbers, JWTs, guest link tokens and secret URL parameters in
 * `text` with placeholders. Idempotent. It can't recognise a bare name, so callers must not put
 * guest names in error messages in the first place.
 */
export function redactText(text: string): string {
  return text
    .replace(ENCODED, (_, hex: string) => DECODED[hex.toLowerCase()]!)
    .replace(JWT, '[jwt]')
    .replace(GUEST_LINK, '/$1/[token]')
    .replace(SECRET_PARAM, '$1[redacted]')
    .replace(EMAIL, '[email]')
    .replace(PHONE, '[phone]')
    .replace(BARE_SECRET, '[secret]');
}

/**
 * A deep copy of `value` with every string passed through `redactText` and the values of
 * contact, token and credential keys (any depth, any case) replaced by `[redacted]`. Use it on
 * whole error events and log payloads. Cycles become `[cycle]`.
 */
export function redactDeep<T>(value: T): T {
  const seen = new WeakSet<object>();
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return redactText(v);
    if (v === null || typeof v !== 'object') return v;
    if (seen.has(v)) return '[cycle]';
    seen.add(v);
    if (Array.isArray(v)) return v.map(walk);
    return Object.fromEntries(
      Object.entries(v).map(([k, inner]) => [k, SECRET_KEY.test(k) ? '[redacted]' : walk(inner)]),
    );
  };
  return walk(value) as T;
}

/** The parts of an error-report event (Sentry's shape) that can carry free text. */
export interface ReportEvent {
  logentry?: unknown;
  extra?: unknown;
  exception?: {
    values?: {
      type?: string;
      value?: string;
      stacktrace?: { frames?: { filename?: string; abs_path?: string }[] };
    }[];
  };
}

/** A URL or path without its query and fragment, which can carry anything. */
export function withoutQuery(url: string): string {
  return url.split(/[?#]/)[0]!;
}

// An exception's type is error.name, which code can set to anything; a class name is safe.
const CLASS_NAME = /^[A-Z][A-Za-z0-9]*$/;

/**
 * `redactDeep(event)` without free text, which can hold a bare name no pattern recognises (#530).
 * Exception messages become the database error code of `original` (the thrown value) when there
 * is one and `[message]` otherwise; `logentry` and `extra` (a thrown plain object's fields) are
 * dropped. Exception types stay when they look like a class name (`Error` otherwise), and
 * stack frames stay with their file URLs cut at the query.
 */
export function withoutFreeText<T extends ReportEvent>(event: T, original?: unknown): T {
  const code = errorCode(original);
  const { logentry: _logentry, extra: _extra, ...rest } = redactDeep(event);
  for (const value of rest.exception?.values ?? []) {
    if (value.value !== undefined) value.value = code === 'unknown' ? '[message]' : code;
    if (value.type !== undefined && !CLASS_NAME.test(value.type)) value.type = 'Error';
    for (const frame of value.stacktrace?.frames ?? []) {
      if (frame.filename) frame.filename = withoutQuery(frame.filename);
      if (frame.abs_path) frame.abs_path = withoutQuery(frame.abs_path);
    }
  }
  return rest as T;
}
