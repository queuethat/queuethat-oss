import { describe, expect, it } from 'vitest';
import { readConfig } from './config.ts';

const env = {
  VITE_SUPABASE_URL: 'http://build.test',
  VITE_SUPABASE_ANON_KEY: 'build-key',
  VITE_PUBLIC_URL: 'https://build.example.com',
} as const;

describe('readConfig', () => {
  it('falls back to the build-time env when there is no runtime config', () => {
    const c = readConfig(undefined, env);
    expect(c.supabaseUrl).toBe('http://build.test');
    expect(c.supabaseAnonKey).toBe('build-key');
    expect(c.publicUrl).toBe('https://build.example.com');
    expect(c.demoMode).toBe(false);
  });

  it('reads the Stripe dashboard base from the runtime config or the build env, empty by default', () => {
    expect(readConfig(undefined, env).stripeDashboardUrl).toBe('');
    expect(
      readConfig(undefined, {
        ...env,
        VITE_STRIPE_DASHBOARD_URL: 'https://dashboard.stripe.com/test',
      }).stripeDashboardUrl,
    ).toBe('https://dashboard.stripe.com/test');
    expect(
      readConfig({ STRIPE_DASHBOARD_URL: 'https://run.example' }, env).stripeDashboardUrl,
    ).toBe('https://run.example');
  });

  it('falls back when the runtime config is the empty object the dev server serves', () => {
    expect(readConfig({}, env).supabaseUrl).toBe('http://build.test');
  });

  it('prefers runtime values, so one image serves any API', () => {
    const a = readConfig({ SUPABASE_URL: 'https://a.example.com', SUPABASE_ANON_KEY: 'ka' }, env);
    const b = readConfig({ SUPABASE_URL: 'https://b.example.com', SUPABASE_ANON_KEY: 'kb' }, env);
    expect([a.supabaseUrl, b.supabaseUrl]).toEqual([
      'https://a.example.com',
      'https://b.example.com',
    ]);
    expect(a.supabaseAnonKey).toBe('ka');
  });

  it('ignores an empty runtime value and trims a trailing slash from the API URL', () => {
    const c = readConfig(
      { SUPABASE_URL: '', PUBLIC_URL: ' https://q.example.com ' },
      {
        VITE_SUPABASE_URL: 'http://build.test/',
      },
    );
    expect(c.supabaseUrl).toBe('http://build.test');
    expect(c.publicUrl).toBe('https://q.example.com');
  });

  it('turns demo mode on only for the string true', () => {
    expect(readConfig({ DEMO_MODE: 'true' }, {}).demoMode).toBe(true);
    expect(readConfig({ DEMO_MODE: 'TRUE' }, {}).demoMode).toBe(true);
    expect(readConfig({ DEMO_MODE: 'false' }, {}).demoMode).toBe(false);
    expect(readConfig({ DEMO_MODE: '1' }, {}).demoMode).toBe(false);
  });

  describe('terms, privacy and support of whoever runs the install', () => {
    it('has none built in: unset means no link and no support form', () => {
      for (const runtime of [undefined, {}]) {
        const c = readConfig(runtime, env);
        expect([c.termsUrl, c.privacyUrl, c.supportEmail]).toEqual(['', '', '']);
      }
    });

    it('takes build-time values when there is no runtime config', () => {
      const c = readConfig(undefined, {
        ...env,
        VITE_TERMS_URL: 'https://fork.example/terms',
        VITE_SUPPORT_EMAIL: 'help@fork.example',
      });
      expect(c.termsUrl).toBe('https://fork.example/terms');
      expect(c.privacyUrl).toBe('');
      expect(c.supportEmail).toBe('help@fork.example');
    });

    it('a self-hosted install that sets none gets none, whatever was baked into the build', () => {
      // The web image always writes the three keys, empty when unset.
      const c = readConfig(
        { TERMS_URL: '', PRIVACY_URL: '', SUPPORT_EMAIL: '' },
        {
          ...env,
          VITE_TERMS_URL: 'https://build.example/terms',
        },
      );
      expect([c.termsUrl, c.privacyUrl, c.supportEmail]).toEqual(['', '', '']);
    });

    it('a self-hosted install uses its own values', () => {
      const c = readConfig(
        {
          TERMS_URL: 'https://shop.example/terms',
          PRIVACY_URL: ' https://shop.example/privacy ',
          SUPPORT_EMAIL: 'help@shop.example',
        },
        env,
      );
      expect(c.termsUrl).toBe('https://shop.example/terms');
      expect(c.privacyUrl).toBe('https://shop.example/privacy');
      expect(c.supportEmail).toBe('help@shop.example');
    });
  });
});
