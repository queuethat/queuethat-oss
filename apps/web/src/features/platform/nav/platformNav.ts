export type PlatformRole = 'support' | 'operator';
export type PlatformGroupId = 'customers' | 'operations' | 'oversight';
export type PlatformNavKey =
  | 'tenants'
  | 'funnel'
  | 'messages'
  | 'health'
  | 'stats'
  | 'blocks'
  | 'announcements'
  | 'audit'
  | 'incidents'
  | 'team'
  | 'security';

type Link =
  | {
      to:
        | '/platform'
        | '/platform/funnel'
        | '/platform/messages'
        | '/platform/team'
        | '/platform/mfa';
    }
  | { to: '/platform/$'; params: { _splat: string } };

export interface PlatformNavItem {
  key: PlatformNavKey;
  link: Link;
  /** Current on this exact path... */
  exact?: string;
  /** ...and on this path and everything under it. */
  prefix?: string;
  operatorOnly?: boolean;
}

export interface PlatformNavGroup {
  id: PlatformGroupId;
  items: PlatformNavItem[];
}

const splat = (key: PlatformNavKey, path: string): PlatformNavItem => ({
  key,
  link: { to: '/platform/$', params: { _splat: path } },
  prefix: `/platform/${path}`,
});

/** Every console page, grouped by what the operator is doing: serving tenants, running the platform, or checking on it. */
const GROUPS: PlatformNavGroup[] = [
  {
    id: 'customers',
    items: [
      { key: 'tenants', link: { to: '/platform' }, exact: '/platform', prefix: '/platform/orgs' },
      { key: 'funnel', link: { to: '/platform/funnel' }, prefix: '/platform/funnel' },
      { key: 'messages', link: { to: '/platform/messages' }, prefix: '/platform/messages' },
    ],
  },
  {
    id: 'operations',
    items: [
      splat('health', 'health'),
      splat('stats', 'stats'),
      splat('blocks', 'blocks'),
      splat('announcements', 'announcements'),
    ],
  },
  {
    id: 'oversight',
    items: [
      splat('audit', 'audit'),
      { ...splat('incidents', 'incidents'), operatorOnly: true },
      { key: 'team', link: { to: '/platform/team' }, prefix: '/platform/team', operatorOnly: true },
      { key: 'security', link: { to: '/platform/mfa' }, prefix: '/platform/mfa' },
    ],
  },
];

/** The groups this role may see; support staff do not get the team list. */
export function platformNavGroups(role: PlatformRole): PlatformNavGroup[] {
  return GROUPS.map((g) => ({
    ...g,
    items: g.items.filter((i) => !i.operatorOnly || role === 'operator'),
  })).filter((g) => g.items.length > 0);
}

const under = (pathname: string, prefix: string) =>
  pathname === prefix || pathname.startsWith(`${prefix}/`);

/** The item whose page `pathname` belongs to, so exactly one link is marked current. */
export function currentNavKey(pathname: string): PlatformNavKey | undefined {
  return GROUPS.flatMap((g) => g.items).find(
    (i) => pathname === i.exact || (i.prefix !== undefined && under(pathname, i.prefix)),
  )?.key;
}
