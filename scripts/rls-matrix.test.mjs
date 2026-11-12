import { describe, expect, it } from 'vitest';
import { BASE_ACTORS, loadMatrix } from './rls-matrix.mjs';

const files = {
  'matrix.yaml': `
global_tables: [app.dial_codes]
tables:
  app.visits:
    where: 'true'
    update: x = x
    insert: default values
    allow:
      select: [owner, staff]
`,
  'matrix.hosted.yaml': `
actors: [platform]
global_tables: [app.plans]
tables:
  app.plans:
    where: 'true'
    update: x = x
    insert: default values
    allow:
      select: [owner, platform]
allow_extra:
  app.visits:
    select: [platform, owner]
    update: [platform]
`,
};
const load = (f) => loadMatrix(Object.keys(f), (n) => f[n]);

describe('loadMatrix', () => {
  it('reads matrix.yaml alone like before', () => {
    const m = load({ 'matrix.yaml': files['matrix.yaml'] });
    expect(m.errors).toEqual([]);
    expect(m.actors).toEqual(BASE_ACTORS);
    expect(Object.keys(m.tables)).toEqual(['app.visits']);
    expect(m.globalTables).toEqual(['app.dial_codes']);
  });

  it('adds a deployment file: actors, tables, global tables and extra allows', () => {
    const m = load(files);
    expect(m.errors).toEqual([]);
    expect(m.actors).toEqual([...BASE_ACTORS, 'platform']);
    expect(Object.keys(m.tables)).toEqual(['app.visits', 'app.plans']);
    expect(m.globalTables).toEqual(['app.dial_codes', 'app.plans']);
    expect(m.tables['app.visits'].allow).toEqual({
      select: ['owner', 'staff', 'platform'],
      update: ['platform'],
    });
  });

  it('ignores files that are not matrix.<name>.yaml', () => {
    const m = load({ ...files, 'notes.yaml': 'tables: {app.x: {}}', 'matrix.test.sql': '' });
    expect(m.errors).toEqual([]);
    expect(Object.keys(m.tables)).toEqual(['app.visits', 'app.plans']);
  });

  it('refuses a table listed twice and an extra allow on an unknown table', () => {
    const m = load({
      ...files,
      'matrix.z.yaml': `
tables:
  app.visits: {where: 'true', update: x = x, insert: default values, allow: {}}
allow_extra:
  app.nope: {select: [platform]}
`,
    });
    expect(m.errors).toEqual([
      'matrix.z.yaml: app.visits is already listed; use allow_extra to add actors',
      'matrix.z.yaml: allow_extra names app.nope, which no matrix lists',
    ]);
  });
});
