import { describe, expect, it } from 'vitest';
import { currentNavKey, platformNavGroups } from './platformNav.ts';

const keys = (role: 'support' | 'operator') =>
  platformNavGroups(role).map((g) => g.items.map((i) => i.key));

describe('platform nav', () => {
  it('groups every console page by what the operator is doing', () => {
    expect(keys('operator')).toEqual([
      ['tenants', 'funnel', 'messages'],
      ['health', 'stats', 'blocks', 'announcements'],
      ['audit', 'incidents', 'team', 'security'],
    ]);
    expect(platformNavGroups('operator').map((g) => g.id)).toEqual([
      'customers',
      'operations',
      'oversight',
    ]);
  });

  it('keeps the team list and the incident register for operators only', () => {
    expect(keys('support').flat()).not.toContain('team');
    expect(keys('support').flat()).not.toContain('incidents');
    expect(keys('support').flat()).toHaveLength(keys('operator').flat().length - 2);
  });

  it('opens each page at the path the old links used', () => {
    const links = platformNavGroups('operator').flatMap((g) => g.items.map((i) => i.link));
    expect(links).toContainEqual({ to: '/platform/$', params: { _splat: 'health' } });
    expect(links).toContainEqual({ to: '/platform/$', params: { _splat: 'announcements' } });
    expect(links).toContainEqual({ to: '/platform/funnel' });
    expect(links).toContainEqual({ to: '/platform/mfa' });
  });

  it('marks one page current, tenant detail pages under Tenants', () => {
    expect(currentNavKey('/platform')).toBe('tenants');
    expect(currentNavKey('/platform/orgs/9f2c')).toBe('tenants');
    expect(currentNavKey('/platform/health')).toBe('health');
    expect(currentNavKey('/platform/audit')).toBe('audit');
    expect(currentNavKey('/platform/messages')).toBe('messages');
    expect(currentNavKey('/platform/mfa')).toBe('security');
    expect(currentNavKey('/platform/healthy')).toBeUndefined();
    expect(currentNavKey('/admin')).toBeUndefined();
  });
});
