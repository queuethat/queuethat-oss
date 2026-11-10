import { describe, expect, it } from 'vitest';
import { findProblems } from './check-answers-not-in-outbound.mjs';

const readers = new Map([['public-join/handler.ts', 'ok']]);

describe('findProblems', () => {
  it('flags a function that starts handling answers without being listed', () => {
    const files = {
      'dispatch-notifications/handler.ts': 'const a = await db.from("visit_answers").select();',
    };
    expect(findProblems(files, [], readers)).toHaveLength(1);
  });

  it('ignores comments and the English verb in them', () => {
    const files = {
      'health/handler.ts': '// Answers 200 when the database answers\nexport const x = 1;',
    };
    expect(findProblems(files, [], readers)).toEqual([]);
  });

  it('allows a listed reader, but not when it logs answers', () => {
    const quiet = { 'public-join/handler.ts': 'const answers = b.answers;\nreturn run(answers);' };
    expect(findProblems(quiet, [], readers)).toEqual([]);
    const loud = {
      'public-join/handler.ts': 'const answers = b.answers;\nerror("join failed", answers);',
    };
    expect(findProblems(loud, [], readers)).toHaveLength(1);
  });

  it('flags an answer store in the org export', () => {
    expect(findProblems({}, ['visits', 'form_responses'], readers)).toHaveLength(1);
  });
});
