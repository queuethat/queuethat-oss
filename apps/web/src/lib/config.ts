/**
 * Public configuration, in one place. A self-hosted install serves `/config.js`, written from the
 * container's environment at start, which sets `window.__APP_CONFIG__` before the bundle loads
 * (so one image fits every install, and the CSP needs no inline script). Everything else (dev,
 * Cloudflare Pages) leaves it empty and the build-time `VITE_*` values apply. Only public values
 * belong here: never the service role key or the JWT secret.
 */
export interface AppConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
  /** The address guests use, printed on QR posters. Empty: use the page's origin. */
  publicUrl: string;
  vapidPublicKey: string;
  /** The Telegram bot's username (public). Empty hides "Get updates on Telegram". */
  telegramBot: string;
  sentryDsn: string;
  sentryIssuesUrl: string;
  /** Stripe dashboard base for "Open in Stripe" in the support console. Empty: the live dashboard. */
  stripeDashboardUrl: string;
  authTurnstileSiteKey: string;
  /** Which CAPTCHA the public-join function uses: turnstile, pow or dev. Empty: join directly. */
  publicJoin: string;
  /** True on an install started with DEMO_MODE=true (#212). */
  demoMode: boolean;
  /** Terms of service page linked from sign-up and the SMS opt-in. Empty hides the link. */
  termsUrl: string;
  /** Privacy notice linked from sign-up, the SMS opt-in and the retention sentence. Empty hides the link. */
  privacyUrl: string;
  /** Where "Contact support" leads. Empty hides the button. */
  supportEmail: string;
}

/**
 * The operator's own pages and inbox, used when nothing is configured: the hosted service and
 * `pnpm dev`. A self-hosted install never falls back to these (see `operatorValue`).
 */
export const HOSTED_DEFAULTS = {
  termsUrl: 'https://queuethat.com/terms',
  privacyUrl: 'https://queuethat.com/privacy',
  supportEmail: 'support@queuethat.com',
} as const;

/** The shape of `window.__APP_CONFIG__`: the container's variable names, all strings. */
export type RuntimeConfig = Partial<
  Record<
    | 'SUPABASE_URL'
    | 'SUPABASE_ANON_KEY'
    | 'PUBLIC_URL'
    | 'VAPID_PUBLIC_KEY'
    | 'TELEGRAM_BOT'
    | 'SENTRY_DSN'
    | 'SENTRY_ISSUES_URL'
    | 'STRIPE_DASHBOARD_URL'
    | 'AUTH_TURNSTILE_SITE_KEY'
    | 'PUBLIC_JOIN'
    | 'DEMO_MODE'
    | 'TERMS_URL'
    | 'PRIVACY_URL'
    | 'SUPPORT_EMAIL',
    string
  >
>;

declare global {
  interface Window {
    __APP_CONFIG__?: RuntimeConfig;
  }
}

/**
 * Merges the runtime config over the build-time env; a runtime value wins when it is not empty.
 * Pure, so tests pass both sources.
 */
export function readConfig(
  runtime: RuntimeConfig | undefined,
  env: Partial<ImportMetaEnv>,
): AppConfig {
  const pick = (run: keyof RuntimeConfig, build: keyof ImportMetaEnv) =>
    (runtime?.[run] || (env[build] as string | undefined) || '').trim();
  /**
   * Whose terms, privacy notice and support inbox the app points at. A runtime key that is
   * present decides, even when empty: the self-host image always writes all three, so an install
   * that sets none shows no link rather than someone else's legal pages. Otherwise the build
   * value, then the hosted default.
   */
  const operatorValue = (run: keyof RuntimeConfig, build: keyof ImportMetaEnv, hosted: string) => {
    const set = runtime?.[run];
    if (set !== undefined) return set.trim();
    return ((env[build] as string | undefined) || hosted).trim();
  };
  return {
    supabaseUrl: pick('SUPABASE_URL', 'VITE_SUPABASE_URL').replace(/\/+$/, ''),
    supabaseAnonKey: pick('SUPABASE_ANON_KEY', 'VITE_SUPABASE_ANON_KEY'),
    publicUrl: pick('PUBLIC_URL', 'VITE_PUBLIC_URL'),
    vapidPublicKey: pick('VAPID_PUBLIC_KEY', 'VITE_VAPID_PUBLIC_KEY'),
    telegramBot: pick('TELEGRAM_BOT', 'VITE_TELEGRAM_BOT').replace(/^@/, ''),
    sentryDsn: pick('SENTRY_DSN', 'VITE_SENTRY_DSN'),
    sentryIssuesUrl: pick('SENTRY_ISSUES_URL', 'VITE_SENTRY_ISSUES_URL'),
    stripeDashboardUrl: pick('STRIPE_DASHBOARD_URL', 'VITE_STRIPE_DASHBOARD_URL'),
    authTurnstileSiteKey: pick('AUTH_TURNSTILE_SITE_KEY', 'VITE_AUTH_TURNSTILE_SITE_KEY'),
    publicJoin: pick('PUBLIC_JOIN', 'VITE_PUBLIC_JOIN'),
    demoMode: (runtime?.DEMO_MODE ?? '').trim().toLowerCase() === 'true',
    termsUrl: operatorValue('TERMS_URL', 'VITE_TERMS_URL', HOSTED_DEFAULTS.termsUrl),
    privacyUrl: operatorValue('PRIVACY_URL', 'VITE_PRIVACY_URL', HOSTED_DEFAULTS.privacyUrl),
    supportEmail: operatorValue(
      'SUPPORT_EMAIL',
      'VITE_SUPPORT_EMAIL',
      HOSTED_DEFAULTS.supportEmail,
    ),
  };
}

/** The current configuration. Read on each call, so tests can stub the env. */
export function appConfig(): AppConfig {
  return readConfig(window.__APP_CONFIG__, import.meta.env);
}
