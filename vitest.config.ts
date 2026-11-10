import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'packages',
          include: [
            'packages/*/src/**/*.test.ts',
            'tests/docs/**/*.test.ts',
            'tests/compliance/**/*.test.ts',
          ],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'ui',
          include: ['packages/ui/src/**/*.test.tsx'],
          environment: 'jsdom',
          setupFiles: ['packages/ui/src/test/setup.ts'],
        },
      },
      {
        test: {
          name: 'repo-scripts',
          include: ['.github/scripts/**/*.test.mjs', 'scripts/**/*.test.mjs'],
          environment: 'node',
        },
      },
      {
        extends: './apps/web/vite.config.ts',
        test: {
          name: 'web',
          root: './apps/web',
          include: ['src/**/*.test.{ts,tsx}'],
          environment: 'jsdom',
          setupFiles: ['src/test/setup.ts'],
          // Public placeholders so modules that create the Supabase client can load. Unit tests
          // never reach the network: with no stored session, getSession() answers locally.
          env: { VITE_SUPABASE_URL: 'http://127.0.0.1:55321', VITE_SUPABASE_ANON_KEY: 'unit-test' },
        },
      },
      {
        test: {
          name: 'web-scripts',
          root: './apps/web',
          include: ['scripts/**/*.test.{ts,mjs}'],
          environment: 'node',
        },
      },
    ],
  },
});
