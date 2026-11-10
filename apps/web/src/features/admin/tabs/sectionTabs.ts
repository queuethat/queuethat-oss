import type { LinkProps } from '@tanstack/react-router';
import type { en } from '../../../locales/en/index.ts';

type ItemKey = keyof (typeof en)['admin-nav']['items'];

export type SectionId = 'insights' | 'connections' | 'developers' | 'privacy' | 'plan';

export type TabLabelKey =
  `items.${ItemKey}` | 'insights.reports' | 'insights.scheduled' | 'insights.compare';

export interface SectionTab {
  id: string;
  to: LinkProps['to'];
  /** The tab is current for this path and everything under it. */
  prefix: string;
  labelKey: TabLabelKey;
}

export interface TabAccess {
  admin: boolean;
  multiLocation: boolean;
}

interface Section {
  id: SectionId;
  /** Width of the column the bar and the page share. */
  width: string;
  /** Pages under these paths wear the bar. */
  prefixes: string[];
  tabs: (access: TabAccess) => SectionTab[];
}

const tab = (
  id: string,
  to: LinkProps['to'],
  labelKey: TabLabelKey,
  prefix = String(to),
): SectionTab => ({ id, to, prefix, labelKey });

const SECTIONS: Section[] = [
  {
    id: 'insights',
    width: 'max-w-5xl',
    prefixes: [
      '/admin/analytics',
      '/admin/heatmap',
      '/admin/performance',
      '/admin/eta-accuracy',
      '/admin/feedback',
      '/admin/reports',
      '/admin/comparison',
    ],
    tabs: ({ admin, multiLocation }) => [
      tab('analytics', '/admin/analytics', 'items.analytics'),
      tab('heatmap', '/admin/heatmap', 'items.heatmap'),
      tab('performance', '/admin/performance', 'items.performance'),
      tab('etaAccuracy', '/admin/eta-accuracy', 'items.etaAccuracy'),
      tab('feedback', '/admin/feedback', 'items.feedback'),
      tab(
        'reports',
        admin ? '/admin/reports/schedules' : '/admin/reports/custom',
        'insights.reports',
        '/admin/reports',
      ),
      ...(admin && multiLocation
        ? [tab('comparison', '/admin/comparison', 'insights.compare')]
        : []),
    ],
  },
  {
    id: 'connections',
    width: 'max-w-3xl',
    prefixes: [
      '/admin/integrations',
      '/admin/whatsapp',
      '/admin/google',
      '/admin/account/calendar',
    ],
    tabs: () => [
      tab('integrations', '/admin/integrations', 'items.integrations'),
      tab('whatsapp', '/admin/whatsapp', 'items.whatsapp'),
      tab('google', '/admin/google', 'items.google'),
      tab('calendar', '/admin/account/calendar', 'items.calendar'),
    ],
  },
  {
    id: 'developers',
    width: 'max-w-3xl',
    prefixes: ['/admin/developers', '/admin/domains'],
    tabs: ({ admin }) =>
      admin
        ? [
            tab('apiKeys', '/admin/developers/api-keys', 'items.apiKeys'),
            tab('webhooks', '/admin/developers/webhooks', 'items.webhooks'),
            tab('chatAlerts', '/admin/developers/chat-alerts', 'items.chatAlerts'),
            tab('domains', '/admin/domains', 'items.domains'),
          ]
        : [],
  },
  {
    id: 'privacy',
    width: 'max-w-3xl',
    prefixes: ['/admin/privacy', '/admin/export'],
    tabs: ({ admin }) => [
      tab('privacy', '/admin/privacy', 'items.privacy'),
      ...(admin
        ? [
            tab('requests', '/admin/privacy/requests', 'items.requests'),
            tab('export', '/admin/export', 'items.export'),
          ]
        : []),
    ],
  },
  {
    id: 'plan',
    width: 'max-w-4xl',
    prefixes: ['/admin/usage'],
    tabs: () => [tab('usage', '/admin/usage', 'items.usage')],
  },
];

const under = (pathname: string, prefix: string) =>
  pathname === prefix || pathname.startsWith(`${prefix}/`);

/** The section whose pages hold `pathname`, if any. */
export function sectionAt(pathname: string): Section | undefined {
  return SECTIONS.find((s) => s.prefixes.some((prefix) => under(pathname, prefix)));
}

/** The three report pages: scheduled ones are for admins, the others for everyone. */
export function reportTabs(admin: boolean): SectionTab[] {
  return [
    ...(admin ? [tab('schedules', '/admin/reports/schedules', 'insights.scheduled')] : []),
    tab('custom', '/admin/reports/custom', 'items.customReports'),
    tab('ask', '/admin/reports/ask', 'items.askAnalytics'),
  ];
}

/** The tab whose prefix is the longest match for `pathname`, if any. */
export function currentTabId(tabs: SectionTab[], pathname: string): string | undefined {
  const hits = tabs.filter((t) => under(pathname, t.prefix));
  return hits.sort((a, b) => b.prefix.length - a.prefix.length)[0]?.id;
}
