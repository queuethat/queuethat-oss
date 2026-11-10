import { describe, expect, it } from 'vitest';
import { pageLinks, parseDirectorySearch } from './search.ts';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';

describe('parseDirectorySearch', () => {
  it('#1135: keeps a valid tag lower-cased and drops a malformed one', () => {
    expect(parseDirectorySearch({ tag: 'VIP' })).toEqual({ tag: 'vip' });
    expect(parseDirectorySearch({ tag: 'churn-risk', q: 'a' })).toEqual({
      q: 'a',
      tag: 'churn-risk',
    });
    expect(parseDirectorySearch({ tag: 'has space' })).toEqual({});
    expect(parseDirectorySearch({ tag: '' })).toEqual({});
    expect(parseDirectorySearch({ tag: 'a'.repeat(31) })).toEqual({});
    expect(parseDirectorySearch({ tag: ['vip'] })).toEqual({});
  });

  it('#581: drops a cursor that is not a uuid, so the first page opens', () => {
    expect(parseDirectorySearch({ after: 'not-a-uuid' })).toEqual({});
    expect(parseDirectorySearch({ after: A, before: 'nope' })).toEqual({ after: A });
  });

  it('keeps a good filter and cursor, and drops the trail without a cursor', () => {
    expect(parseDirectorySearch({ q: 'barber', status: 'suspended', after: B, before: A })).toEqual(
      {
        q: 'barber',
        status: 'suspended',
        after: B,
        before: A,
      },
    );
    expect(parseDirectorySearch({ before: A })).toEqual({});
    expect(parseDirectorySearch({ status: 'gone', q: '' })).toEqual({});
  });
});

describe('pageLinks', () => {
  it('walks forward recording the cursors and back popping them (#583)', () => {
    const first = pageLinks({}, A);
    expect(first.previous).toBeNull();
    expect(first.next).toEqual({ after: A });

    const second = pageLinks({ after: A }, B);
    expect(second.previous).toEqual({});
    expect(second.next).toEqual({ after: B, before: A });

    const third = pageLinks({ after: B, before: A }, C);
    expect(third.previous).toEqual({ after: A });
    expect(third.next).toEqual({ after: C, before: `${A},${B}` });

    expect(pageLinks({ after: C, before: `${A},${B}` }, undefined).previous).toEqual({
      after: B,
      before: A,
    });
  });

  it('offers no next page on the last page', () => {
    expect(pageLinks({ after: A }, undefined).next).toBeNull();
  });
});
