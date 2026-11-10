import { appConfig } from '../../../lib/config.ts';

/** Where guests reach the app: `PUBLIC_URL` when set (lib/config.ts), else this browser's origin. */
const baseUrl = () => appConfig().publicUrl || window.location.origin;

/** The `<script>` tag a business pastes into its website to embed the join widget (J7, #245). */
export function widgetSnippet(slug: string, base: string = baseUrl()): string {
  const src = new URL('/widget.js', base).href;
  return `<script src="${src}" data-location="${slug}" async></script>`;
}

/** The widget page itself, for the live preview. */
export function widgetPreviewUrl(slug: string, base: string = baseUrl()): string {
  return new URL(`/w/${encodeURIComponent(slug)}`, base).href;
}
