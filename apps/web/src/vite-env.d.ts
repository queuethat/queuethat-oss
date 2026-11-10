/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
  /** Public VAPID key for web push (N5). Unset hides the alert opt-in. Never the private key. */
  readonly VITE_VAPID_PUBLIC_KEY?: string;
  /** Telegram bot username (N-3). Unset hides the Telegram opt-in. Public; never the bot token. */
  readonly VITE_TELEGRAM_BOT?: string;
  /** Sentry (or GlitchTip) DSN for error reports (O6). Public by design; unset sends nothing. */
  readonly VITE_SENTRY_DSN?: string;
  /** Sentry (or GlitchTip) issues page, linked from /platform/health. Unset hides the link. */
  readonly VITE_SENTRY_ISSUES_URL?: string;
  /** Stripe dashboard base for "Open in Stripe" on /platform: https://dashboard.stripe.com/test for a sandbox. Unset: live. */
  readonly VITE_STRIPE_DASHBOARD_URL?: string;
  /** The address guests use, printed on QR posters (G7). Unset uses the admin page's origin. */
  readonly VITE_PUBLIC_URL?: string;
  /** "true" ships the /dev/inbox fake SMS inbox (also on in `pnpm dev`). Never in production. */
  readonly VITE_DEV_INBOX?: string;
  /** turnstile | pow | dev: join through the public-join Edge Function with that CAPTCHA. Unset: direct RPC. */
  readonly VITE_PUBLIC_JOIN?: string;
  /**
   * Cloudflare Turnstile site key for sign-in, sign-up and sign-in links (#76). Public by design.
   * Set it once Supabase Auth's CAPTCHA is on; unset sends no token and shows no widget.
   */
  readonly VITE_AUTH_TURNSTILE_SITE_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
