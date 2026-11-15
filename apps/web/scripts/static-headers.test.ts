import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { preview } from 'vite';
import { describe, expect, it } from 'vitest';
import {
  allowLocalApi,
  headersForPath,
  parseHeadersFile,
  staticHeaders,
} from './static-headers.ts';

const headersUrl = new URL('../public/_headers', import.meta.url);
const rules = parseHeadersFile(readFileSync(headersUrl, 'utf8'));

// technical-design.md section 5, "Headers"; issue #74 scope.
const REQUIRED = {
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
};

const lower = (headers: Record<string, string>) =>
  Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));

describe('public/_headers', () => {
  it.each(['/', '/q/demo-barber', '/v/some-token', '/staff', '/admin', '/assets/index.js'])(
    '%s gets every required header',
    (path) => {
      const headers = lower(headersForPath(rules, path));
      expect(headers).toMatchObject(REQUIRED);
      expect(headers['content-security-policy']).toContain(
        "frame-ancestors 'none'; object-src 'none'; base-uri 'self'",
      );
      expect(headers['content-security-policy-report-only']).toBeUndefined();
    },
  );

  it('enforces a CSP that forbids inline scripts (audit WEB-2)', () => {
    const csp = lower(headersForPath(rules, '/'))['content-security-policy'];
    expect(csp).toContain("default-src 'self';");
    // Turnstile's widget (docs/ops/turnstile.md) is the only outside script and frame.
    expect(csp).toContain(
      "script-src 'self' https://challenges.cloudflare.com https://js.stripe.com https://*.js.stripe.com;",
    );
    expect(csp).toContain(
      'frame-src https://challenges.cloudflare.com https://js.stripe.com https://*.js.stripe.com https://hooks.stripe.com;',
    );
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
  });

  it('matches the self-host Caddyfile, apart from the API origin in connect-src', () => {
    const caddy = readFileSync(
      new URL('../../../deploy/selfhost/Caddyfile', import.meta.url),
      'utf8',
    );
    const caddyHeaders = Object.fromEntries(
      [...caddy.matchAll(/^\t\t([\w-]+) "(.*)"$/gm)].map(([, name, value]) => [name, value]),
    );
    const normalize = (value: string) =>
      value
        .replace(/connect-src [^;]*/, 'connect-src <api origin>')
        .replace(/img-src [^;]*/, 'img-src <images>');
    const pages = headersForPath(rules, '/');
    expect(Object.keys(caddyHeaders).sort()).toEqual(Object.keys(pages).sort());
    for (const [name, value] of Object.entries(pages)) {
      expect(normalize(caddyHeaders[name] ?? ''), name).toBe(normalize(value));
    }
  });
});

describe('the embeddable widget (/w/*)', () => {
  const widget = lower(headersForPath(rules, '/w/demo-barber'));
  const caddy = readFileSync(
    new URL('../../../deploy/selfhost/Caddyfile', import.meta.url),
    'utf8',
  );

  it('may be framed by any site and nothing else may', () => {
    expect(widget['x-frame-options']).toBeUndefined();
    expect(widget['content-security-policy']).toContain('frame-ancestors *;');
    expect(widget['content-security-policy']).toContain("default-src 'self';");
    expect(widget['content-security-policy-report-only']).toBeUndefined();
    expect(widget['referrer-policy']).toBe('no-referrer');
    for (const path of ['/', '/q/demo-barber', '/v/t', '/staff', '/widget.js', '/w', '/wx/y']) {
      expect(lower(headersForPath(rules, path))['x-frame-options'], path).toBe('DENY');
    }
  });

  it('is framable in the Caddyfile too', () => {
    expect(caddy).toContain('header @widget -X-Frame-Options');
    const csp = /header @widget Content-Security-Policy "(.*)"$/m.exec(caddy)?.[1] ?? '';
    const normalize = (value: string) =>
      value
        .replace(/connect-src [^;]*/, 'connect-src <api origin>')
        .replace(/img-src [^;]*/, 'img-src <images>');
    expect(normalize(csp)).toBe(normalize(widget['content-security-policy'] ?? ''));
  });
});

describe('allowLocalApi', () => {
  const page = headersForPath(rules, '/');

  it('lets e2e reach the local stack over http', () => {
    const csp = allowLocalApi(page, 'http://127.0.0.1:55321')['Content-Security-Policy'];
    expect(csp).toMatch(/connect-src [^;]* http:\/\/127\.0\.0\.1:55321 ws:\/\/127\.0\.0\.1:55321;/);
    expect(csp).toMatch(/img-src [^;]* http:\/\/127\.0\.0\.1:55321;/);
  });

  it.each(['https://abc.supabase.co', 'http://api.example.com', undefined, 'not a url'])(
    'leaves the policy alone for %s',
    (url) => {
      expect(allowLocalApi(page, url)).toEqual(page);
    },
  );
});

describe('vite preview', () => {
  // Stands in for the Playwright check in #74's test plan until e2e lands: real HTTP
  // responses from the preview server, for the SPA shell and a guest token route.
  it('serves the _headers headers on guest routes', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'qm-preview-'));
    writeFileSync(join(outDir, 'index.html'), '<!doctype html><title>t</title>');
    const server = await preview({
      configFile: false,
      logLevel: 'silent',
      plugins: [staticHeaders(headersUrl)],
      build: { outDir },
      preview: { port: 0, host: '127.0.0.1' },
    });
    try {
      const { port } = server.httpServer.address() as AddressInfo;
      for (const path of ['/', '/v/some-token', '/q/demo-barber']) {
        const response = await fetch(`http://127.0.0.1:${port}${path}`);
        expect(response.status).toBe(200);
        for (const [name, value] of Object.entries(REQUIRED)) {
          expect(response.headers.get(name), `${path} ${name}`).toBe(value);
        }
      }
    } finally {
      await server.close();
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});
