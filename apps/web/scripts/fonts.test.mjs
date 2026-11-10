import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// DS-3: fonts come from our own origin. A font CDN would leak guest IPs, break the offline PWA
// shell and need a CSP hole.
const root = new URL('..', import.meta.url).pathname;
const read = (rel) => readFileSync(join(root, rel), 'utf8');

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? files(full) : [full];
  });
}

describe('self-hosted fonts', () => {
  it('ships both subsets and the licence, each small', () => {
    for (const f of ['geist-latin-var.woff2', 'geist-mono-latin-var.woff2']) {
      const path = join(root, 'public/fonts', f);
      expect(existsSync(path), f).toBe(true);
      expect(statSync(path).size, f).toBeLessThan(40_000);
    }
    expect(existsSync(join(root, 'public/fonts/GEIST-OFL-LICENSE.txt'))).toBe(true);
  });

  it('declares both faces with swap and our own url', () => {
    const css = read('src/styles.css');
    for (const family of ['Geist', 'Geist Mono']) {
      expect(css).toContain(`font-family: '${family}'`);
    }
    expect(css.match(/font-display: swap/g)).toHaveLength(2);
    expect(css).toContain("url('/fonts/geist-latin-var.woff2')");
    expect(css).toContain("url('/fonts/geist-mono-latin-var.woff2')");
  });

  it('preloads the UI face and precaches woff2', () => {
    expect(read('index.html')).toMatch(/rel="preload"[^>]*geist-latin-var\.woff2[^>]*crossorigin/s);
    expect(read('vite.config.ts')).toContain('woff2');
  });

  it('never reaches a font CDN and keeps font-src self', () => {
    const sources = [
      join(root, 'index.html'),
      join(root, 'public/_headers'),
      ...files(join(root, 'src')).filter((f) => /\.(tsx?|css|html)$/.test(f)),
    ];
    for (const f of sources) {
      expect(readFileSync(f, 'utf8'), f).not.toMatch(
        /fonts\.(googleapis|gstatic)\.com|use\.typekit|bunny\.net/,
      );
    }
    expect(read('public/_headers')).toContain("font-src 'self'");
  });

  it('has no serif face configured', () => {
    expect(read('../../packages/ui/src/theme.css')).not.toMatch(/--font-serif/);
  });
});
