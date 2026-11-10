import { ESLint } from 'eslint';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Lints snippets with the repo's real eslint.config.js, as if they were feature files.
const eslint = new ESLint({ cwd: resolve(import.meta.dirname, '../../..') });

async function ruleIds(code: string, file = 'apps/web/src/features/example/Example.tsx') {
  const [result] = await eslint.lintText(code, { filePath: file });
  return result?.messages.map((m) => m.ruleId) ?? [];
}

describe('lint guardrails', () => {
  it.each([
    ['JSX text', `export const Example = () => <p>Join the queue</p>;`],
    [
      'a literal in a JSX expression',
      `export const Example = ({ on }: { on: boolean }) => <p>{on ? 'Open' : 'Closed'}</p>;`,
    ],
    ['a text prop', `export const Example = () => <input aria-label="Phone number" />;`],
    [
      'a component text prop',
      `const Field = (p: { label: string }) => <b>{p.label}</b>;\nexport const Example = () => <Field label="Name" />;`,
    ],
  ])('fails on %s in a feature component', async (_, code) => {
    expect(await ruleIds(code)).toContain('i18next/no-literal-string');
  });

  it('passes translated text and non-text props', async () => {
    const code = `import { useTranslation } from '../../lib/translation.tsx';
export function Example() {
  const { t } = useTranslation('guest');
  return <section className="x" data-testid="join"><h1 id="t">{t('join.title')}</h1></section>;
}`;
    expect(await ruleIds(code)).toEqual([]);
  });

  // #457: channels open only in lib/realtime.ts, which makes them private.
  it.each([
    ['a method call', `declare const c: any;\nc.channel('loc:1');`],
    ['bracket access', `declare const c: any;\nc['channel']('loc:1');`],
    ['destructuring', `declare const c: any;\nconst { channel } = c;\nchannel('loc:1');`],
  ])('fails on a Realtime channel opened outside lib/realtime.ts by %s', async (_, code) => {
    expect(await ruleIds(code, 'apps/web/src/features/example/live.ts')).toContain(
      'no-restricted-properties',
    );
  });

  it('lets lib/realtime.ts open channels', async () => {
    const code = `declare const c: any;\nc.channel('loc:1', { config: { private: true } });`;
    expect(await ruleIds(code, 'apps/web/src/lib/realtime.ts')).not.toContain(
      'no-restricted-properties',
    );
  });

  it('fails on an accessibility violation', async () => {
    expect(await ruleIds(`export const Example = () => <img src="logo.png" />;`)).toContain(
      'jsx-a11y/alt-text',
    );
  });
});

describe('i18n imports', () => {
  it('rejects a value import of react-i18next (guest bundle budget, #1179)', async () => {
    const code = `import { useTranslation } from 'react-i18next';\nexport const x = useTranslation;`;
    expect(await ruleIds(code)).toContain('no-restricted-imports');
  });
});
