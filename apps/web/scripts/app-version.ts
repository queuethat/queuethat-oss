import type { Plugin } from 'vite';

/**
 * D3 (#50): stamps the build with a version and publishes it at `/version.json`, so paired
 * TVs and kiosks can tell when a new deploy is live and reload themselves. The bundle reads
 * its own version from `__APP_VERSION__`. `APP_VERSION` overrides it (e.g. a git sha); by
 * default every build gets a fresh UTC timestamp. The dev server always reports "dev".
 */
export function appVersion(version = process.env.APP_VERSION): Plugin {
  let resolved = 'dev';
  return {
    name: 'qm-app-version',
    config(_config, { command }) {
      if (command === 'build') {
        resolved = version || new Date().toISOString().replace(/\D/g, '').slice(0, 14);
      }
      return { define: { __APP_VERSION__: JSON.stringify(resolved) } };
    },
    configureServer(server) {
      server.middlewares.use('/version.json', (_req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify({ version: resolved }));
      });
    },
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'version.json',
        source: JSON.stringify({ version: resolved }),
      });
    },
  };
}
