import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import i18next from 'eslint-plugin-i18next';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      'docs/**',
      'packages/db-types/src/database.types.ts',
      'apps/web/src/routeTree.gen.ts',
      'supabase/functions/**',
      '**/playwright-report/**',
      '**/playwright-report-visual/**',
      '**/test-results/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx,js,mjs}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}', 'packages/ui/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks, 'jsx-a11y': jsxA11y },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...jsxA11y.flatConfigs.recommended.rules,
    },
  },
  {
    // F8 (#18): features use @qm/ui so hit targets and destructive-action safety can't be skipped.
    files: ['apps/web/src/features/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "JSXOpeningElement[name.name='button']",
          message: 'Use Button, BigButton or ConfirmDestructive from @qm/ui instead of <button>.',
        },
        {
          selector: 'JSXOpeningElement[name.name=/^(input|select|textarea)$/]',
          message:
            'Use Input, Select, Checkbox or PhoneInput from @qm/ui instead of a raw form control.',
        },
        {
          selector: "JSXOpeningElement[name.name='svg']",
          message: 'Use Icon from @qm/ui. Add missing glyphs to packages/ui/src/icons.ts.',
        },
      ],
    },
  },
  {
    // User-facing text goes through t() (F9 #19). Flags JSX text, string literals inside
    // JSX expressions, and literals passed to the text props listed here.
    files: ['apps/web/src/**/*.tsx', 'packages/ui/src/**/*.tsx'],
    ignores: ['**/*.test.tsx', 'apps/web/src/routes/dev/**'],
    plugins: { i18next },
    rules: {
      'i18next/no-literal-string': [
        'error',
        {
          mode: 'jsx-only',
          'jsx-attributes': {
            include: [
              'alt',
              'aria-label',
              'aria-description',
              'aria-placeholder',
              'aria-roledescription',
              'aria-valuetext',
              'description',
              'label',
              'message',
              'placeholder',
              'title',
            ],
          },
        },
      ],
    },
  },
  {
    // #457: Realtime channels are opened in one place, lib/realtime.ts, which joins them private
    // (realtime.test.ts checks). A channel opened anywhere else could skip that. Packages are
    // out of scope (providers has a notification `channel`); in the app, a non-Realtime
    // `channel` property needs an eslint-disable line saying so.
    files: ['apps/web/src/**/*.{ts,tsx}'],
    ignores: ['apps/web/src/lib/realtime.ts', '**/*.test.{ts,tsx}'],
    rules: {
      'no-restricted-properties': [
        'error',
        { property: 'channel', message: 'Open Realtime channels only through lib/realtime.ts.' },
      ],
    },
  },
  {
    // #1179: the guest bundle has no room for i18next or react-i18next. Translate through
    // lib/translation.tsx (`useTranslation`, `Trans`) and lib/i18n.ts; types may still come from
    // i18next (type-only imports are erased).
    files: ['apps/web/src/**/*.{ts,tsx}'],
    ignores: ['**/*.test.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['i18next', 'react-i18next'],
              allowTypeImports: true,
              message: 'Use lib/translation.tsx and lib/i18n.ts; i18next is not in the bundle.',
            },
          ],
        },
      ],
    },
  },
  {
    // F10 (#20): wait on a condition (locator assertions, `eventually`), never on the clock.
    files: ['tests/e2e/**/*.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        { property: 'waitForTimeout', message: 'Use a web-first assertion or `eventually`.' },
      ],
    },
  },
  prettier,
);
