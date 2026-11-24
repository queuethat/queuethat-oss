import { describe, expect, it } from 'vitest';
import { coreImportsEe, missingHeader } from './check-ee-boundary.mjs';

const H = '// SPDX-License-Identifier: LicenseRef-QueueThat-EE\n';

describe('missingHeader', () => {
  it('flags ee code without the header and ignores headed, non-code and non-ee files', () => {
    expect(
      missingHeader({
        'ee/web/a.ts': 'export const a = 1;',
        'ee/web/b.ts': `${H}export const b = 1;`,
        'ee/README.md': '# ee',
        'apps/web/src/c.ts': 'export const c = 1;',
      }),
    ).toEqual([expect.stringContaining('ee/web/a.ts')]);
  });
});

describe('coreImportsEe', () => {
  it('flags relative and bare imports of ee/ from core, not ee-to-ee or other imports', () => {
    const errors = coreImportsEe({
      'apps/web/src/x.ts': "import { a } from '../../../../ee/web/a.ts';",
      'apps/web/src/y.ts': "const m = await import('ee/web/a.ts');",
      'apps/web/src/z.ts': "import { b } from './b.ts'; import r from 'react';",
      'ee/web/a.ts': `${H}import { q } from './q.ts';`,
    });
    expect(errors).toEqual([
      expect.stringContaining('apps/web/src/x.ts'),
      expect.stringContaining('apps/web/src/y.ts'),
    ]);
  });
});
