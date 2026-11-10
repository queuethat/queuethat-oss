import { describe, expect, it } from 'vitest';
import { checkRedefinitions } from './check-redefinitions.mjs';

const fn = (name) =>
  `create or replace function ${name}(p int) returns int language sql as $$ select 1 $$;`;
const old = { name: '20261025001000_join.sql', sql: fn('private.join_core') };
const bump = { name: '20261025003800_bump.sql', sql: fn('private.join_core') };

describe('checkRedefinitions', () => {
  it('ignores merged migrations up to the cutoff', () => {
    expect(checkRedefinitions([old, bump])).toEqual([]);
  });

  it('fails a redefinition that names no base', () => {
    const next = { name: '20261025003900_limit.sql', sql: fn('private.join_core') };
    expect(checkRedefinitions([old, bump, next])).toHaveLength(1);
  });

  it('fails a redefinition built on a stale base', () => {
    const next = {
      name: '20261025003900_limit.sql',
      sql: `-- redefines private.join_core from ${old.name}\n${fn('private.join_core')}`,
    };
    expect(checkRedefinitions([old, bump, next])[0]).toContain(bump.name);
  });

  it('passes a redefinition built on the latest body', () => {
    const next = {
      name: '20261025003900_limit.sql',
      sql: `-- redefines private.join_core from ${bump.name}\n${fn('private.join_core')}`,
    };
    expect(checkRedefinitions([old, bump, next])).toEqual([]);
  });

  it('allows brand-new functions without a note', () => {
    const next = { name: '20261025003900_new.sql', sql: fn('private.something_new') };
    expect(checkRedefinitions([old, bump, next])).toEqual([]);
  });
});
