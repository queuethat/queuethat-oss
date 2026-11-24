import type { LinkProps } from '@tanstack/react-router';
import {
  adminPageUrl,
  installedExtensions,
  type ExtensionAdminPage,
  type ExtensionTabSection,
} from '../../../extensions/index.ts';
import type { en } from '../../../locales/en/index.ts';

type ItemKey = keyof (typeof en)['admin-nav']['items'];

export type SectionId = ExtensionTabSection;

export type TabLabelKey = `items.${ItemKey}` | 'insights.compare';

export interface SectionTab {
  id: string;
  to: LinkProps['to'];
  /** The tab is current for this path and everything under it. */
  prefix: string;
  labelKey: TabLabelKey;
  /** An extension page's tab: `labelKey` is in the extension's own namespace (`ns:key`). */
  extension?: boolean;
}

export interface TabAccess {
  admin: boolean;
  multiLocation: boolean;
  /** Installed extension pages this member is offered; unset offers them all. */
  extensionPages?: ReadonlySet<string>;
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
      '/admin/comparison',
    ],
    tabs: ({ admin, multiLocation }) => [
      tab('analytics', '/admin/analytics', 'items.analytics'),
      tab('heatmap', '/admin/heatmap', 'items.heatmap'),
      tab('performance', '/admin/performance', 'items.performance'),
      tab('etaAccuracy', '/admin/eta-accuracy', 'items.etaAccuracy'),
      tab('feedback', '/admin/feedback', 'items.feedback'),
      ...(admin && multiLocation
        ? [tab('comparison', '/admin/comparison', 'insights.compare')]
        : []),
    ],
  },
  {
    id: 'connections',
    width: 'max-w-3xl',
    prefixes: ['/admin/integrations', '/admin/whatsapp', '/admin/account/calendar'],
    tabs: () => [
      tab('integrations', '/admin/integrations', 'items.integrations'),
      tab('whatsapp', '/admin/whatsapp', 'items.whatsapp'),
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

/** A section with the installed extension pages that join it (`ExtensionAdminPage.tab`). */
function withExtensions(section: Section, pages: ExtensionAdminPage[]): Section {
  const own = pages.filter((p) => p.tab?.section === section.id);
  if (own.length === 0) return section;
  const asTab = (p: ExtensionAdminPage): SectionTab => ({
    id: `x:${p.path}`,
    to: adminPageUrl(p) as LinkProps['to'],
    prefix: adminPageUrl(p),
    labelKey: p.tab!.labelKey as TabLabelKey,
    extension: true,
  });
  return {
    ...section,
    prefixes: [...section.prefixes, ...own.map(adminPageUrl)],
    tabs: (access) => {
      const shown = own.filter((p) => !access.extensionPages || access.extensionPages.has(p.path));
      return [
        ...shown.filter((p) => p.tab!.first).map(asTab),
        ...section.tabs(access),
        ...shown.filter((p) => !p.tab!.first).map(asTab),
      ];
    },
  };
}

/** The section whose pages hold `pathname`, if any, with its extension tabs. */
export function sectionAt(
  pathname: string,
  pages: ExtensionAdminPage[] = installedExtensions().adminPages,
): Section | undefined {
  return SECTIONS.map((s) => withExtensions(s, pages)).find((s) =>
    s.prefixes.some((prefix) => under(pathname, prefix)),
  );
}

/** The tab whose prefix is the longest match for `pathname`, if any. */
export function currentTabId(tabs: SectionTab[], pathname: string): string | undefined {
  const hits = tabs.filter((t) => under(pathname, t.prefix));
  return hits.sort((a, b) => b.prefix.length - a.prefix.length)[0]?.id;
}
