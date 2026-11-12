import type { WebExtensions } from './types.ts';

/**
 * The extensions this build includes: none. A deployment that adds its own pages builds with
 * `QT_WEB_EXTENSIONS=<path to its module>`, and `scripts/extensions.ts` resolves this file to that
 * module instead. Keep this file the only import of the installed set.
 */
export const extensions: WebExtensions = { adminPages: [], banners: [] };
