import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { webExtensions } from './extensions.ts';

const INSTALLED = fileURLToPath(new URL('../src/extensions/installed.ts', import.meta.url));
const OTHER = fileURLToPath(new URL('../src/extensions/index.ts', import.meta.url));

// Calls the plugin's resolveId the way Vite does, with a resolver that maps every source to `id`.
async function resolveWith(module: string | undefined, source: string, id: string) {
  const hook = webExtensions(module).resolveId as unknown as (
    this: { resolve: () => Promise<{ id: string }> },
    source: string,
    importer: string | undefined,
    options: object,
  ) => Promise<string | null>;
  return hook.call({ resolve: async () => ({ id }) }, source, '/x/index.ts', {});
}

describe('webExtensions', () => {
  it('leaves imports alone when no module is set', async () => {
    expect(await resolveWith(undefined, './installed.ts', INSTALLED)).toBeNull();
  });

  it('points installed.ts at the configured module', async () => {
    expect(await resolveWith('/deploy/ext.ts', './installed.ts', INSTALLED)).toBe('/deploy/ext.ts');
  });

  it('does not touch another file with the same name or another module', async () => {
    expect(
      await resolveWith('/deploy/ext.ts', './installed.ts', '/elsewhere/installed.ts'),
    ).toBeNull();
    expect(await resolveWith('/deploy/ext.ts', './index.ts', OTHER)).toBeNull();
  });
});
