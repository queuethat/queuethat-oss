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

/** The shape of `window.__APP_CONFIG__`: the container's variable names, all strings. */
export type RuntimeConfig = Partial<
  Record<
    | 'SUPABASE_URL'
    | 'SUPABASE_ANON_KEY'
    | 'PUBLIC_URL'
    | 'VAPID_PUBLIC_KEY'
    | 'TELEGRAM_BOT'
    | 'SENTRY_DSN'
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
   * Whose terms, privacy notice and support inbox the app points at. Nothing is built in: unset
   * means no link and no support form. A runtime key that is present decides, even when empty,
   * so a self-hosted install is never overridden by a value baked into the image.
   */
  const operatorValue = (run: keyof RuntimeConfig, build: keyof ImportMetaEnv) => {
    const set = runtime?.[run];
    if (set !== undefined) return set.trim();
    return ((env[build] as string | undefined) || '').trim();
  };
  return {
    supabaseUrl: pick('SUPABASE_URL', 'VITE_SUPABASE_URL').replace(/\/+$/, ''),
    supabaseAnonKey: pick('SUPABASE_ANON_KEY', 'VITE_SUPABASE_ANON_KEY'),
    publicUrl: pick('PUBLIC_URL', 'VITE_PUBLIC_URL'),
    vapidPublicKey: pick('VAPID_PUBLIC_KEY', 'VITE_VAPID_PUBLIC_KEY'),
    telegramBot: pick('TELEGRAM_BOT', 'VITE_TELEGRAM_BOT').replace(/^@/, ''),
    sentryDsn: pick('SENTRY_DSN', 'VITE_SENTRY_DSN'),
    authTurnstileSiteKey: pick('AUTH_TURNSTILE_SITE_KEY', 'VITE_AUTH_TURNSTILE_SITE_KEY'),
    publicJoin: pick('PUBLIC_JOIN', 'VITE_PUBLIC_JOIN'),
    demoMode: (runtime?.DEMO_MODE ?? '').trim().toLowerCase() === 'true',
    termsUrl: operatorValue('TERMS_URL', 'VITE_TERMS_URL'),
    privacyUrl: operatorValue('PRIVACY_URL', 'VITE_PRIVACY_URL'),
    supportEmail: operatorValue('SUPPORT_EMAIL', 'VITE_SUPPORT_EMAIL'),
  };
}

/** The current configuration. Read on each call, so tests can stub the env. */
export function appConfig(): AppConfig {
  return readConfig(window.__APP_CONFIG__, import.meta.env);
}
