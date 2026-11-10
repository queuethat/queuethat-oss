import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { headersForPath, parseHeadersFile } from './static-headers.ts';

interface VercelHeaderRule {
  source: string;
  headers: { key: string; value: string }[];
}

const rules = parseHeadersFile(
  readFileSync(new URL('../public/_headers', import.meta.url), 'utf8'),
);
const config = JSON.parse(
  readFileSync(new URL('../../../vercel.json', import.meta.url), 'utf8'),
) as {
  headers: VercelHeaderRule[];
  rewrites: { source: string; destination: string }[];
};

const toRegExp = (source: string) => new RegExp(`^${source}$`);

function vercelHeadersForPath(path: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rule of config.headers) {
    if (!toRegExp(rule.source).test(path)) continue;
    for (const { key, value } of rule.headers) result[key] = value;
  }
  return result;
}

describe('vercel.json', () => {
  it.each([
    '/',
    '/q/demo-barber',
    '/v/some-token',
    '/staff',
    '/assets/index.js',
    '/sw.js',
    '/version.json',
    '/w/demo-barber',
    '/wx',
  ])('%s gets the same headers as public/_headers', (path) => {
    expect(vercelHeadersForPath(path)).toEqual(headersForPath(rules, path));
  });

  it('sends unknown paths to the SPA shell', () => {
    expect(config.rewrites).toEqual([{ source: '/(.*)', destination: '/index.html' }]);
  });
});
