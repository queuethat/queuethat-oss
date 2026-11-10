import {
  iconAlertTriangle,
  iconBell,
  iconCalendar,
  iconChart,
  iconClock,
  iconCreditCard,
  iconHelp,
  iconHome,
  iconLink,
  iconList,
  iconMonitor,
  iconPencil,
  iconPlug,
  iconQr,
  iconShield,
  iconSliders,
  iconUsers,
  type IconDef,
  type NavGroup,
  type NavItem,
} from '@qm/ui';
import { useQuery } from '@tanstack/react-query';
import type { LinkProps } from '@tanstack/react-router';
import { useTranslation } from '../../../lib/translation.tsx';
import type { en } from '../../../locales/en/index.ts';
import { useCurrentLocation, useCurrentOrg } from '../../auth/current.ts';
import { orgBillingQuery } from '../billing/api.ts';
import type { SectionId } from '../tabs/sectionTabs.ts';

export interface AdminNavItem extends NavItem {
  to: LinkProps['to'];
  /** Active only on this exact path (the parent of other entries). */
  exact?: boolean;
  /** Left out of the sidebar (the page wears tabs); still searchable in the palette. */
  hidden?: boolean;
  /** The sidebar item that stands for this page while it is open. */
  under?: string;
  /** What the sidebar calls this item when it differs from `label`. */
  sidebarLabel?: string;
}

type ItemKey = keyof (typeof en)['admin-nav']['items'];

interface Entry {
  to: LinkProps['to'];
  /** Key under `items.` in the admin-nav namespace; also the item id. */
  key: ItemKey;
  icon: IconDef;
  exact?: boolean;
  adminOnly?: boolean;
  ownerOnly?: boolean;
  multiLocation?: boolean;
  hidden?: boolean;
  under?: ItemKey;
  /** The sidebar names this page for the section it opens; the palette keeps the page's own name. */
  sidebarLabel?: SectionId;
}

type GroupId = 'run' | 'team' | 'setup' | 'insights' | 'account' | 'danger';

/**
 * Every admin destination, grouped by the owner's job. `run` opens by default; the other labelled
 * groups start collapsed (the one holding the current page opens). `danger` renders last,
 * unlabelled, behind a divider.
 */
const GROUPS: { id: GroupId; entries: Entry[] }[] = [
  {
    id: 'run',
    entries: [
      { to: '/admin', key: 'today', icon: iconHome },
      { to: '/admin/overview', key: 'overview', icon: iconHome },
      { to: '/staff', key: 'liveQueue', icon: iconList, exact: true },
      { to: '/admin/appointments', key: 'appointments', icon: iconCalendar },
      { to: '/admin/events', key: 'events', icon: iconCalendar },
      { to: '/admin/guests', key: 'guests', icon: iconUsers },
      { to: '/admin/notifications/failed', key: 'failedMessages', icon: iconBell },
    ],
  },
  {
    id: 'team',
    entries: [
      { to: '/admin/team', key: 'team', icon: iconUsers, adminOnly: true },
      { to: '/admin/roles', key: 'roles', icon: iconUsers, adminOnly: true },
      { to: '/admin/shifts', key: 'shifts', icon: iconClock },
      { to: '/staff/planning', key: 'planning', icon: iconClock },
    ],
  },
  {
    id: 'setup',
    entries: [
      { to: '/admin/location', key: 'location', icon: iconSliders, exact: true },
      { to: '/admin/queues', key: 'queues', icon: iconSliders },
      { to: '/admin/routing', key: 'routing', icon: iconSliders },
      { to: '/admin/queues/priority', key: 'priority', icon: iconSliders },
      { to: '/admin/resources', key: 'counters', icon: iconSliders },
      { to: '/admin/availability', key: 'availability', icon: iconCalendar },
      { to: '/admin/location/hours', key: 'hours', icon: iconClock },
      { to: '/admin/forms', key: 'forms', icon: iconList },
      { to: '/admin/templates', key: 'templates', icon: iconBell },
      { to: '/admin/journeys', key: 'journeys', icon: iconList },
      { to: '/admin/branding', key: 'branding', icon: iconPencil },
      { to: '/admin/widget', key: 'widget', icon: iconQr },
      { to: '/admin/devices', key: 'devices', icon: iconMonitor },
      { to: '/admin/signage', key: 'signage', icon: iconMonitor },
      { to: '/admin/poster', key: 'poster', icon: iconQr },
      { to: '/admin/blocks', key: 'blocks', icon: iconShield },
      { to: '/admin/location/new', key: 'addLocation', icon: iconSliders, adminOnly: true },
    ],
  },
  {
    id: 'insights',
    entries: [
      { to: '/admin/analytics', key: 'analytics', icon: iconChart },
      {
        to: '/admin/performance',
        key: 'performance',
        icon: iconChart,
        hidden: true,
        under: 'analytics',
      },
      { to: '/admin/heatmap', key: 'heatmap', icon: iconChart, hidden: true, under: 'analytics' },
      {
        to: '/admin/eta-accuracy',
        key: 'etaAccuracy',
        icon: iconClock,
        hidden: true,
        under: 'analytics',
      },
      { to: '/admin/feedback', key: 'feedback', icon: iconHelp, hidden: true, under: 'analytics' },
      { to: '/admin/reports/schedules', key: 'reports', icon: iconChart, adminOnly: true },
      {
        to: '/admin/reports/custom',
        key: 'customReports',
        icon: iconChart,
        hidden: true,
        under: 'reports',
      },
      {
        to: '/admin/reports/ask',
        key: 'askAnalytics',
        icon: iconChart,
        hidden: true,
        under: 'reports',
      },
      {
        to: '/admin/comparison',
        key: 'comparison',
        icon: iconChart,
        adminOnly: true,
        multiLocation: true,
        hidden: true,
        under: 'analytics',
      },
    ],
  },
  {
    id: 'account',
    entries: [
      {
        to: '/admin/billing',
        key: 'billing',
        icon: iconCreditCard,
        ownerOnly: true,
        hidden: true,
        under: 'usage',
      },
      { to: '/admin/usage', key: 'usage', icon: iconChart, sidebarLabel: 'plan' },
      {
        to: '/admin/integrations',
        key: 'integrations',
        icon: iconPlug,
        sidebarLabel: 'connections',
      },
      {
        to: '/admin/whatsapp',
        key: 'whatsapp',
        icon: iconBell,
        hidden: true,
        under: 'integrations',
      },
      { to: '/admin/google', key: 'google', icon: iconLink, hidden: true, under: 'integrations' },
      {
        to: '/admin/account/calendar',
        key: 'calendar',
        icon: iconCalendar,
        hidden: true,
        under: 'integrations',
      },
      {
        to: '/admin/developers/api-keys',
        key: 'apiKeys',
        icon: iconLink,
        adminOnly: true,
        sidebarLabel: 'developers',
      },
      {
        to: '/admin/developers/webhooks',
        key: 'webhooks',
        icon: iconLink,
        adminOnly: true,
        hidden: true,
        under: 'apiKeys',
      },
      {
        to: '/admin/developers/chat-alerts',
        key: 'chatAlerts',
        icon: iconLink,
        adminOnly: true,
        hidden: true,
        under: 'apiKeys',
      },
      {
        to: '/admin/domains',
        key: 'domains',
        icon: iconLink,
        adminOnly: true,
        hidden: true,
        under: 'apiKeys',
      },
      {
        to: '/admin/export',
        key: 'export',
        icon: iconList,
        adminOnly: true,
        hidden: true,
        under: 'privacy',
      },
      {
        to: '/admin/privacy',
        key: 'privacy',
        icon: iconShield,
        exact: true,
        sidebarLabel: 'privacy',
      },
      {
        to: '/admin/privacy/requests',
        key: 'requests',
        icon: iconShield,
        adminOnly: true,
        hidden: true,
        under: 'privacy',
      },
      { to: '/admin/settings/support', key: 'support', icon: iconHelp },
    ],
  },
  {
    id: 'danger',
    entries: [{ to: '/admin/settings/danger', key: 'danger', icon: iconAlertTriangle }],
  },
];

export interface NavFilter {
  role: string | undefined;
  /** An owner on a deployment with billing switched on. */
  billing: boolean;
  multiLocation: boolean;
}

/** Pure: applies the role filters to the table above. Empty groups are dropped. */
export function buildGroups(
  filter: NavFilter,
  label: (key: ItemKey) => string,
  groupLabel: (id: GroupId) => string,
  sectionLabel: (id: SectionId) => string,
): NavGroup<AdminNavItem>[] {
  const admin = filter.role === 'owner' || filter.role === 'admin';
  return GROUPS.map(({ id, entries }) => ({
    id,
    label: id === 'danger' ? undefined : groupLabel(id),
    defaultOpen: id === 'run' ? true : undefined,
    items: entries
      .filter(
        (e) =>
          (!e.adminOnly || admin) &&
          (!e.ownerOnly || (filter.role === 'owner' && filter.billing)) &&
          (!e.multiLocation || filter.multiLocation),
      )
      .map((e) => ({
        id: e.key,
        to: e.to,
        exact: e.exact,
        icon: e.icon,
        label: label(e.key),
        hidden: e.hidden,
        under: e.under,
        sidebarLabel: e.sidebarLabel && sectionLabel(e.sidebarLabel),
      })),
  })).filter((g) => g.items.length > 0);
}

/** The groups as the sidebar draws them: pages that wear tabs are left to the palette. */
export function sidebarGroups(groups: NavGroup<AdminNavItem>[]): NavGroup<AdminNavItem>[] {
  return groups.map((g) => ({
    ...g,
    items: g.items
      .filter((i) => !i.hidden)
      .map((i) => ({ ...i, label: i.sidebarLabel ?? i.label })),
  }));
}

/**
 * The sidebar item for `pathname`: the longest matching `to` (`exact` items match only themselves).
 * A hidden page answers with the item it sits under, or its group's first shown item.
 */
export function currentItemId(
  groups: NavGroup<AdminNavItem>[],
  pathname: string,
): string | undefined {
  let best: { item: AdminNavItem; len: number } | undefined;
  for (const item of groups.flatMap((g) => g.items)) {
    const to = String(item.to);
    const hit =
      pathname === to || (!item.exact && to !== '/admin' && pathname.startsWith(`${to}/`));
    if (hit && (!best || to.length > best.len)) best = { item, len: to.length };
  }
  if (!best?.item.hidden) return best?.item.id;
  const shown = groups.find((g) => g.items.includes(best.item))?.items.filter((i) => !i.hidden);
  return (shown?.find((i) => i.id === best.item.under) ?? shown?.[0])?.id;
}

/** What this member's role, billing and location count allow them to see. */
export function useNavFilter(): NavFilter {
  const org = useCurrentOrg();
  const role = org?.role;
  const billing = useQuery({ ...orgBillingQuery(org?.id ?? ''), enabled: role === 'owner' });
  const { locations } = useCurrentLocation();
  return { role, billing: billing.data?.enabled === true, multiLocation: locations.length > 1 };
}

/** The groups this member may see, translated. */
export function useAdminNavGroups(): NavGroup<AdminNavItem>[] {
  const { t } = useTranslation('admin-nav');
  return buildGroups(
    useNavFilter(),
    (key) => t(`items.${key}`),
    (id) => t(`groups.${id as Exclude<GroupId, 'danger'>}`),
    (id) => t(`sections.${id}`),
  );
}

/** For the palette: which group an item belongs to, so advanced items can be marked. */
export function groupOf(
  groups: NavGroup<AdminNavItem>[],
  itemId: string,
): NavGroup<AdminNavItem> | undefined {
  return groups.find((g) => g.items.some((i) => i.id === itemId));
}
