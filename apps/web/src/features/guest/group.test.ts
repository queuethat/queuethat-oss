import { beforeEach, describe, expect, it } from 'vitest';
import { forgetVisit, groupKeyFor, groupMembers, rememberGroup } from './api.ts';

const members = [
  { token: 'tok-parent', name: 'Parent' },
  { token: 'tok-child', name: 'Child' },
];

describe('groups', () => {
  beforeEach(() => localStorage.clear());

  it('keeps one group key per queue until the group is saved', () => {
    const key = groupKeyFor('q1');
    expect(groupKeyFor('q1')).toBe(key);
    expect(groupKeyFor('q2')).not.toBe(key);
    rememberGroup('q1', members);
    expect(groupKeyFor('q1')).not.toBe(key);
  });

  it('lists the whole group from any member, and the join page returns to the first', () => {
    rememberGroup('q1', members);
    expect(groupMembers('tok-child')).toEqual(members);
    expect(localStorage.getItem('qm:visit:q1')).toBe('tok-parent');
    expect(groupMembers('someone-else')).toEqual([]);
  });

  it('points the join page at the next member when the first one ends', () => {
    rememberGroup('q1', members);
    forgetVisit('tok-parent');
    expect(localStorage.getItem('qm:visit:q1')).toBe('tok-child');
    forgetVisit('tok-child');
    expect(localStorage.getItem('qm:visit:q1')).toBeNull();
  });
});
