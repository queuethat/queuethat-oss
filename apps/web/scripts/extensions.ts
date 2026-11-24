import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

const INSTALLED = fileURLToPath(new URL('../src/extensions/installed.ts', import.meta.url));
const APP_SRC = fileURLToPath(new URL('../src/', import.meta.url));

/**
 * Builds the app with a deployment's own extensions (src/extensions): when `QT_WEB_EXTENSIONS` names a
 * module, every import of src/extensions/installed.ts resolves to it instead. Unset, the app builds
 * with none. A relative path is taken from the current directory.
 */
export function webExtensions(module = process.env.QT_WEB_EXTENSIONS): Plugin {
  const target = module ? (isAbsolute(module) ? module : resolve(module)) : undefined;
  return {
    name: 'qt-web-extensions',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      // Code under ee/web reaches the app's own modules as `@app/<path under src>` (tsconfig `paths`).
      if (source.startsWith('@app/')) {
        return this.resolve(`${APP_SRC}${source.slice('@app/'.length)}`, importer, {
          ...options,
          skipSelf: true,
        });
      }
      if (!target || !source.endsWith('installed.ts')) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      return resolved?.id === INSTALLED ? target : null;
    },
  };
}
