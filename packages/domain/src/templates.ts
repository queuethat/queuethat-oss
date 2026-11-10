/**
 * Notification template renderer shared by the dispatcher (Deno) and the template editor
 * preview (browser), so a preview is exactly what is sent. Dependency-free and pure.
 *
 * Syntax: `{{name}}` substitutes a variable. The system defaults written before 2P-NTF5 use the
 * legacy `{name}`, which renders the same. Text is plain: nothing is interpreted as HTML, and
 * substituted values are never expanded again.
 */

/** What a variable renders as when the message has no value for it, per locale. */
const FALLBACKS: Record<string, Record<string, string>> = {
  en: {
    guest_first_name: 'there',
    queue_name: 'the queue',
    location_name: 'us',
    counter: 'the counter',
    eta_range: 'a few minutes',
    business_phone: 'the front desk',
    appointment_time: 'your appointment time',
    status_link: 'your status page',
  },
};

const NAME = String.raw`[\w.]+`;
const PLACEHOLDER = new RegExp(String.raw`\{\{\s*(${NAME})\s*\}\}|\{(${NAME})\}`, 'g');
const SEGMENT = new RegExp(
  String.raw` ?\[([^[\]]*(?:\{\{\s*${NAME}\s*\}\}|\{${NAME}\})[^[\]]*)\]`,
  'g',
);

/**
 * Renders `body` with `vars`.
 *
 * - A `[segment]` holding placeholders is optional: it renders without its brackets when every
 *   placeholder in it has a value, and disappears (with the space before it) otherwise.
 * - Outside a segment a missing value renders the variable's fallback in `locale` (English when
 *   the locale has none), or nothing for variables that have no fallback.
 * - No `{{` of the template survives rendering.
 */
export function renderTemplate(body: string, vars: Record<string, unknown>, locale = 'en'): string {
  const has = (key: string) => vars[key] !== undefined && vars[key] !== null && vars[key] !== '';
  const fallbacks = FALLBACKS[locale] ?? FALLBACKS['en']!;
  const fill = (text: string) =>
    text.replace(PLACEHOLDER, (_, double?: string, single?: string) => {
      const key = (double ?? single)!;
      return has(key) ? String(vars[key]) : (fallbacks[key] ?? '');
    });
  const names = (inner: string) => [...inner.matchAll(PLACEHOLDER)].map((m) => (m[1] ?? m[2])!);
  // Segments are resolved first so a missing value drops its segment instead of the fallback.
  const kept = body.replace(SEGMENT, (segment, inner: string) =>
    names(inner).every(has) ? segment.replace(/\[|\]/g, '') : '',
  );
  return fill(kept);
}

/**
 * Variables an editable template may use, per trigger, for the editor's chips and preview. The
 * database (`private.template_variables`) is the authority and rejects anything else with
 * `unknown_variable`; this list only saves the owner a failed save.
 */
export const TEMPLATE_VARIABLES: Record<string, readonly string[]> = Object.fromEntries(
  ['called', 'almost_up', 'position_changed', 'eta_changed'].map((trigger) => [
    trigger,
    [
      'guest_first_name',
      'ticket',
      'queue_name',
      'location_name',
      'counter',
      'eta_range',
      'status_link',
      'appointment_time',
      'business_phone',
      'unsubscribe_url',
      'position',
    ],
  ]),
);

/** Example values for the editor's live preview. */
export const SAMPLE_TEMPLATE_VARS: Record<string, string> = {
  guest_first_name: 'Sam',
  ticket: 'A012',
  queue_name: 'Walk-ins',
  location_name: 'Main Street',
  counter: 'Chair 1',
  eta_range: '10–15 min',
  status_link: 'https://example.test/v/abc',
  appointment_time: '3:30 pm',
  business_phone: '+1 415 555 0100',
  unsubscribe_url: 'https://example.test/u/abc',
  position: '3',
  position_up: '3',
  eta_sooner: '10 min',
};

/**
 * Values for an approved WhatsApp template's positional parameters ({{1}}, {{2}}, ...): the
 * placeholders of `body` in order of appearance, each rendered like {@link renderTemplate} does
 * (its value, else its fallback). Meta refuses an empty parameter, so a value with neither
 * becomes "-". Optional `[segments]` do not exist for approved templates, so they are ignored.
 */
export function templateParams(
  body: string,
  vars: Record<string, unknown>,
  locale = 'en',
): string[] {
  return [...body.matchAll(PLACEHOLDER)].map((m) => {
    const key = (m[1] ?? m[2])!;
    // Meta refuses newlines, tabs, runs of 4+ spaces and over 1024 characters in a parameter.
    return (
      renderTemplate(`{{${key}}}`, vars, locale).replace(/\s+/g, ' ').trim().slice(0, 1000) || '-'
    );
  });
}
