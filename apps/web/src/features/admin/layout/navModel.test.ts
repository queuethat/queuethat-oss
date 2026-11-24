import { iconHome } from '@qm/ui';
import { describe, expect, it } from 'vitest';
import { filterPalette } from './GoToPalette.tsx';
import { buildGroups, currentItemId, sidebarGroups } from './navModel.ts';

const label = (key: string) => key;
const group = (id: string) => id;
const build = (role: string, extra: Partial<{ multiLocation: boolean }> = {}) =>
  buildGroups({ role, multiLocation: false, ...extra }, label, group, group);
const ids = (groups: ReturnType<typeof build>) => groups.flatMap((g) => g.items.map((i) => i.id));

// The routes of the flat menu this replaced: nothing may disappear or move URL. (/admin/roles is
// gone from this list: it is an ee/ page now and redirects to /admin/x/roles.)
const PREVIOUS = [
  '/admin',
  '/admin/overview',
  '/admin/shifts',
  '/admin/queues',
  '/admin/resources',
  '/admin/appointments',
  '/admin/events',
  '/staff/planning',
  '/admin/availability',
  '/admin/guests',
  '/admin/blocks',
  '/admin/privacy',
  '/admin/privacy/requests',
  '/admin/devices',
  '/admin/developers/api-keys',
  '/admin/developers/webhooks',
  '/admin/developers/chat-alerts',
  '/admin/location',
  '/admin/team',
  '/admin/location/hours',
  '/admin/location/new',
  '/admin/analytics',
  '/admin/performance',
  '/admin/eta-accuracy',
  '/admin/heatmap',
  '/admin/feedback',
  '/admin/comparison',
  '/admin/forms',
  '/admin/templates',
  '/admin/journeys',
  '/admin/notifications/failed',
  '/admin/usage',
  '/admin/export',
  '/admin/domains',
  '/admin/reports/schedules',
  '/admin/reports/custom',
  '/admin/reports/ask',
  '/admin/integrations',
  '/admin/whatsapp',
  '/admin/poster',
  '/admin/widget',
  '/admin/google',
  '/admin/branding',
  '/admin/signage',
  '/admin/account/calendar',
  '/admin/help',
  '/admin/settings/danger',
];

const SURFACED = ['/staff', '/admin/routing', '/admin/queues/priority', '/admin/services'];

describe('admin nav model', () => {
  it('keeps every previous destination and surfaces the live queue, routing and priority', () => {
    const all = build('owner', { multiLocation: true })
      .flatMap((g) => g.items)
      .map((i) => String(i.to));
    expect(all.sort()).toEqual([...PREVIOUS, ...SURFACED].sort());
  });

  it('leads with Run, open by default, then four collapsed groups named for the owner’s jobs', () => {
    const groups = build('owner');
    expect(groups[0]!.id).toBe('run');
    expect(groups[0]!.defaultOpen).toBe(true);
    expect(groups[0]!.items.map((i) => i.id)).toEqual([
      'today',
      'overview',
      'liveQueue',
      'appointments',
      'events',
      'guests',
      'failedMessages',
    ]);
    for (const g of groups.filter((x) => x.label && x.id !== 'run')) {
      expect(g.defaultOpen).toBeUndefined();
    }
    expect(groups.filter((g) => g.label).map((g) => g.id)).toEqual([
      'run',
      'team',
      'setup',
      'advanced',
      'insights',
      'account',
    ]);
  });

  it('keeps Set up to the first-day pages and files the rest under Advanced', () => {
    const groups = build('owner');
    const setup = groups.find((g) => g.id === 'setup')!;
    // #88: services and availability are everyday setup.
    expect(setup.items.map((i) => i.id)).toEqual([
      'location',
      'queues',
      'services',
      'hours',
      'availability',
      'forms',
      'templates',
      'poster',
    ]);
    const advanced = groups.find((g) => g.id === 'advanced')!;
    expect(advanced.items.map((i) => i.id)).toEqual(
      expect.arrayContaining(['routing', 'priority', 'counters', 'branding']),
    );
    expect(advanced.items.map((i) => i.id)).not.toContain('services');
    expect(advanced.defaultOpen).toBeUndefined();
  });

  it('puts integrations, developer tools and Danger zone under Account', () => {
    const groups = build('owner');
    const account = groups.find((g) => g.id === 'account')!;
    expect(account.items.map((i) => i.id)).toEqual(
      expect.arrayContaining([
        'integrations',
        'whatsapp',
        'google',
        'apiKeys',
        'domains',
        'export',
      ]),
    );
    expect(account.defaultOpen).toBeUndefined();
    // #88: Danger zone is the last entry of Account, not a group of its own.
    expect(account.items.at(-1)!.id).toBe('danger');
    expect(groups.map((g) => g.id)).not.toContain('danger');
  });

  it('applies the role filters unchanged', () => {
    const staff = ids(build('staff'));
    for (const hidden of [
      'apiKeys',
      'webhooks',
      'chatAlerts',
      'domains',
      'export',
      'reports',
      'requests',
      'comparison',
    ]) {
      expect(staff).not.toContain(hidden);
    }
    expect(ids(build('admin'))).toContain('apiKeys');
    expect(ids(build('admin'))).not.toContain('comparison');
    expect(ids(build('admin', { multiLocation: true }))).toContain('comparison');
  });

  it('finds the current item by longest match, honouring exact', () => {
    const groups = build('owner');
    expect(currentItemId(groups, '/admin')).toBe('today');
    expect(currentItemId(groups, '/admin/location')).toBe('location');
    expect(currentItemId(groups, '/admin/location/hours')).toBe('hours');
    expect(currentItemId(groups, '/admin/privacy/requests')).toBe('privacy');
    expect(currentItemId(groups, '/admin/queues/abc')).toBe('queues');
    const holder = (path: string) => {
      const id = currentItemId(groups, path);
      return groups.find((g) => g.items.some((i) => i.id === id))?.id;
    };
    expect(holder('/admin/heatmap')).toBe('insights'); // its group opens on arrival
    expect(holder('/admin/queues')).toBe('setup');
    expect(currentItemId(groups, '/admin/queues/priority')).toBe('priority');
    expect(currentItemId(groups, '/admin/routing')).toBe('routing');
    expect(currentItemId(groups, '/staff')).toBe('liveQueue');
    expect(currentItemId(groups, '/staff/planning')).toBe('planning');
    expect(currentItemId(groups, '/admin/nope')).toBeUndefined();
  });

  it('shows two Insights entries in the sidebar and leaves the tab pages to the palette', () => {
    const insights = (role: string) =>
      sidebarGroups(build(role))
        .find((g) => g.id === 'insights')!
        .items.map((i) => i.id);
    expect(insights('owner')).toEqual(['analytics', 'reports']);
    expect(insights('staff')).toEqual(['analytics']);
    const palette = filterPalette(build('owner'), 'heatmap').map((r) => r.item.id);
    expect(palette).toEqual(['heatmap']);
  });

  it('shows one Account entry per section, named for the section, plus help', () => {
    const entries = (role: string, extra = {}) =>
      sidebarGroups(build(role, extra)).find((g) => g.id === 'account')!.items;
    expect(entries('owner').map((i) => i.id)).toEqual([
      'usage',
      'integrations',
      'apiKeys',
      'privacy',
      'help',
      'danger',
    ]);
    expect(entries('owner').map((i) => i.label)).toEqual([
      'plan',
      'connections',
      'developers',
      'privacy',
      'help',
      'danger',
    ]);
    expect(entries('staff').map((i) => i.id)).toEqual([
      'usage',
      'integrations',
      'privacy',
      'help',
      'danger',
    ]);
  });

  it('keeps each account page searchable under its own name', () => {
    const groups = build('owner');
    expect(filterPalette(groups, 'apikeys').map((r) => r.item.id)).toEqual(['apiKeys']);
    expect(filterPalette(groups, 'whatsapp').map((r) => r.item.id)).toEqual(['whatsapp']);
  });

  it('marks the entry an account page sits under', () => {
    const owner = build('owner');
    const at = (path: string) => currentItemId(owner, path);
    expect(at('/admin/whatsapp')).toBe('integrations');
    expect(at('/admin/account/calendar')).toBe('integrations');
    expect(at('/admin/developers/webhooks')).toBe('apiKeys');
    expect(at('/admin/domains')).toBe('apiKeys');
    expect(at('/admin/privacy/requests')).toBe('privacy');
    expect(at('/admin/export')).toBe('privacy');
    expect(at('/admin/help')).toBe('help');
  });

  it('marks the sidebar entry a tabbed page sits under', () => {
    const owner = build('owner', { multiLocation: true });
    expect(currentItemId(owner, '/admin/heatmap')).toBe('analytics');
    expect(currentItemId(owner, '/admin/feedback')).toBe('analytics');
    expect(currentItemId(owner, '/admin/comparison')).toBe('analytics');
    expect(currentItemId(owner, '/admin/reports/custom')).toBe('reports');
    expect(currentItemId(owner, '/admin/reports/ask')).toBe('reports');
    expect(currentItemId(build('staff'), '/admin/reports/custom')).toBe('analytics');
  });

  it('palette search matches names and group names, advanced pages included', () => {
    const groups = build('owner');
    expect(filterPalette(groups, 'webhook').map((r) => r.item.id)).toEqual(['webhooks']);
    expect(filterPalette(groups, '').length).toBe(groups.flatMap((g) => g.items).length);
    expect(filterPalette(groups, 'ACCOUNT').length).toBe(
      groups.find((g) => g.id === 'account')!.items.length,
    );
    expect(filterPalette(groups, 'routing').map((r) => r.item.id)).toEqual(['routing']);
    expect(filterPalette(groups, 'priority').map((r) => r.item.id)).toEqual(['priority']);
    expect(filterPalette(groups, 'zzz')).toEqual([]);
  });
});

describe('extension pages in the nav', () => {
  const load = () => Promise.resolve({ default: () => null });
  const pages = [
    {
      path: 'billing',
      load,
      nav: { group: 'account' as const, icon: iconHome, labelKey: 'x:billing' },
    },
    {
      path: 'secret',
      load,
      nav: { group: 'setup' as const, icon: iconHome, labelKey: 'x:secret', adminOnly: true },
    },
    { path: 'no-nav', load },
  ];
  const withPages = (role: string) =>
    buildGroups({ role, multiLocation: false }, label, group, group, pages, (k) => `T(${k})`);

  it('adds none in this repository', () => {
    expect(ids(build('owner')).filter((id) => id.startsWith('x:'))).toEqual([]);
  });

  it('appends each page with a nav entry to the end of its group, translated', () => {
    const account = withPages('owner').find((g) => g.id === 'account');
    expect(account?.items.at(-1)).toMatchObject({
      id: 'x:billing',
      to: '/admin/x/billing',
      label: 'T(x:billing)',
    });
    expect(ids(withPages('owner'))).toContain('x:secret');
    expect(ids(withPages('owner'))).not.toContain('x:no-nav');
  });

  it('hides admin-only extension pages from staff', () => {
    expect(ids(withPages('staff'))).toContain('x:billing');
    expect(ids(withPages('staff'))).not.toContain('x:secret');
  });

  it('marks an extension page current when it is open', () => {
    expect(currentItemId(withPages('owner'), '/admin/x/billing')).toBe('x:billing');
  });

  it('keeps a hidden page out of the sidebar, under the item it names, and drops pages not offered', () => {
    const hiddenPage = {
      path: 'billing',
      load,
      nav: {
        group: 'account' as const,
        icon: iconHome,
        labelKey: 'x:billing',
        hidden: true,
        under: 'usage',
      },
    };
    const groups = buildGroups({ role: 'owner', multiLocation: false }, label, group, group, [
      hiddenPage,
    ]);
    expect(ids(groups)).toContain('x:billing');
    expect(ids(sidebarGroups(groups))).not.toContain('x:billing');
    expect(currentItemId(groups, '/admin/x/billing')).toBe('usage');
    const notOffered = buildGroups(
      { role: 'owner', multiLocation: false, extensionPages: new Set() },
      label,
      group,
      group,
      [hiddenPage],
    );
    expect(ids(notOffered)).not.toContain('x:billing');
  });
});
