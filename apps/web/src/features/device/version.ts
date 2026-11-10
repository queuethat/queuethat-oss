/**
 * This build's version; `/version.json` reports the deployed one (scripts/app-version.ts).
 * Outside Vite (the e2e suite imports the constants below) there is no build, hence "dev".
 */
declare const __APP_VERSION__: string | undefined; // replaced by Vite's `define`
export const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';

/** How often a paired screen sends a heartbeat and checks for a new deploy. */
export const POLL_MS = 60_000;

/** A kiosk counts as idle after this long without a touch or key press. A TV is always idle. */
export const IDLE_MS = 30_000;

/** Never reload twice within this window, so a stale CDN copy of index.html can't loop. */
export const RELOAD_COOLDOWN_MS = 5 * 60_000;

export interface ReloadCheck {
  /** The version this bundle was built as. */
  running: string;
  /** The version `/version.json` reported, or undefined before the first poll. */
  served: string | undefined;
  idleForMs: number;
  /** When this screen last reloaded for an update, if it remembers. */
  lastReloadAt: number | undefined;
  now: number;
}

/**
 * True when a paired screen should reload to pick up a new deploy: the served version differs,
 * nobody is using the screen, and it hasn't just reloaded for the same reason.
 */
export function shouldReload({ running, served, idleForMs, lastReloadAt, now }: ReloadCheck) {
  if (!served || served === running) return false;
  if (idleForMs < IDLE_MS) return false;
  return lastReloadAt === undefined || now - lastReloadAt >= RELOAD_COOLDOWN_MS;
}
