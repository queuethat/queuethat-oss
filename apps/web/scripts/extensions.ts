import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const INSTALLED = fileURLToPath(new URL('../src/extensions/installed.ts', import.meta.url));
const APP_SRC = fileURLToPath(new URL('../src/', import.meta.url));

const VIRTUAL = '\0qt-web-extensions';
const MERGE = fileURLToPath(new URL('../src/extensions/merge.ts', import.meta.url));

/**
 * Builds the app with a deployment's own extensions (src/extensions): when `QT_WEB_EXTENSIONS` names a
 * module, every import of src/extensions/installed.ts resolves to it instead. Unset, the app builds
 * with none. Several modules may be named, separated by commas (`src/hosted/extensions.ts,ee/web/extensions.ts`):
 * they are merged in order, the later one winning a clash (src/extensions/merge.ts). A relative path is
 * taken from the current directory, or else from the repository root (so
 * `QT_WEB_EXTENSIONS=ee/web/extensions.ts pnpm dev` works from anywhere).
 */
export function webExtensions(module = process.env.QT_WEB_EXTENSIONS): Plugin {
  const targets = (module ?? '')
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean)
    .map((m) => {
      const found = isAbsolute(m)
        ? m
        : [resolve(m), resolve(REPO_ROOT, m)].find((p) => existsSync(p));
      // A named module that is nowhere would build the app without it and look fine: fail instead.
      if (!found) throw new Error(`QT_WEB_EXTENSIONS: no module at "${m}"`);
      return found;
    });
  // One module is used as it is; several are merged by a generated module.
  const target = targets.length === 1 ? targets[0] : targets.length > 1 ? VIRTUAL : undefined;
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
      if (source === VIRTUAL) return VIRTUAL;
      if (!target || !source.endsWith('installed.ts')) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      return resolved?.id === INSTALLED ? target : null;
    },
    load(id) {
      if (id !== VIRTUAL) return null;
      const imports = targets.map(
        (t, i) => `import { extensions as e${i} } from ${JSON.stringify(t)};`,
      );
      return [
        `import { mergeExtensions } from ${JSON.stringify(MERGE)};`,
        ...imports,
        `export const extensions = mergeExtensions([${targets.map((_, i) => `e${i}`).join(', ')}]);`,
      ].join('\n');
    },
  };
}
