import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { appVersion } from './scripts/app-version.ts';
import { staticHeaders } from './scripts/static-headers.ts';

export default defineConfig({
  plugins: [
    tanstackRouter({ target: 'react', autoCodeSplitting: true }),
    react(),
    tailwindcss(),
    staticHeaders(new URL('./public/_headers', import.meta.url)),
    appVersion(),
    // O1 (#72). Custom service worker (src/sw.ts) so the push handler (N5) lives in the same file.
    // features/pwa registers the worker itself and decides per tab when a waiting version applies.
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'prompt',
      injectRegister: false,
      includeAssets: ['favicon.svg', 'apple-touch-icon-180x180.png'],
      manifest: {
        name: 'QueueThat',
        short_name: 'QueueThat',
        description: 'Join a line, track your turn, and run the queue.',
        // No start_url, so a Home Screen icon opens the page it was added from (the manifest
        // spec's default). iPhone guests need their /v/:token page there to get push (N5 #71);
        // staff and devices land back on their own screen. id keeps one app identity.
        start_url: undefined,
        id: '/',
        scope: '/',
        display: 'standalone',
        background_color: '#f6f6f2',
        theme_color: '#f6f6f2',
        icons: [
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'maskable-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      // config.js is written per install at start; the worker serves it itself (src/sw.ts).
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        globIgnores: ['config.js'],
      },
    }),
  ],
  build: {
    // scripts/check-bundle-size.mjs reads the manifest to enforce the guest-route budget.
    manifest: true,
    // Maps for Sentry only: no sourceMappingURL in the bundle, and scripts/sourcemaps.mjs
    // uploads them (when a token is set) and deletes them before anything is deployed.
    sourcemap: 'hidden',
    rolldownOptions: {
      output: {
        // The libraries every page runs on live in one chunk. Left alone, Rolldown re-splits them
        // whenever a new route changes the chunk graph, and each split costs gzip bytes on
        // every guest route (#796 added 2.8 KB that way).
        advancedChunks: {
          groups: [
            {
              name: 'core',
              test: /node_modules\/(\.pnpm\/[^/]+\/node_modules\/)?(react|react-dom|scheduler|react-i18next|i18next|@tanstack\/(react-router|router-core|react-query|query-core|react-store|store))\//,
            },
          ],
        },
      },
    },
  },
});
