import { describe, expect, it } from 'vitest';
import { permittedActions } from './api.ts';

describe('permittedActions', () => {
  const all = ['call', 'recall', 'start', 'cancel', 'remove', 'no_show'] as const;

  it('keeps every action while the permissions are unknown', () => {
    expect(permittedActions([...all], undefined)).toEqual([...all]);
  });

  it('drops calling and removing without their permissions', () => {
    expect(permittedActions([...all], ['visits.remove'])).toEqual([
      'start',
      'cancel',
      'remove',
      'no_show',
    ]);
    expect(permittedActions([...all], ['visits.call'])).toEqual([
      'call',
      'recall',
      'start',
      'no_show',
    ]);
  });

  it('never touches actions that need no permission', () => {
    expect(permittedActions(['start', 'no_show'], [])).toEqual(['start', 'no_show']);
  });
});
