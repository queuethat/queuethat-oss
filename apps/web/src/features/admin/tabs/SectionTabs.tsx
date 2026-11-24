import { Link, useRouterState } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { useTranslation } from '../../../lib/translation.tsx';
import { useNavFilter } from '../layout/navModel.ts';
import { currentTabId, sectionAt, type SectionTab } from './sectionTabs.ts';

const BASE =
  'inline-flex min-h-target items-center rounded-control px-4 font-semibold transition-colors';
const LOOK = {
  on: 'bg-primary text-on-primary',
  off: 'bg-secondary text-on-secondary hover:bg-secondary-hover',
};

function TabLinks({
  label,
  tabs,
  current,
}: {
  label: string;
  tabs: SectionTab[];
  current: string | undefined;
}) {
  const { t, i18n } = useTranslation('admin-nav');
  // An extension tab's label is in the extension's own namespace (`ns:key`).
  const tabLabel = (tab: SectionTab) =>
    tab.extension ? (i18n.t as (key: string) => string)(tab.labelKey) : t(tab.labelKey);
  return (
    <nav aria-label={label}>
      <ul className="flex gap-2 overflow-x-auto">
        {tabs.map((tab) => {
          const selected = tab.id === current;
          return (
            <li key={tab.id} className="shrink-0">
              <Link
                to={tab.to}
                activeOptions={{ exact: true }}
                aria-current={selected ? 'page' : 'false'}
                className={`${BASE} ${LOOK[selected ? 'on' : 'off']}`}
              >
                {tabLabel(tab)}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/**
 * Gives the pages of one section (insights, connections, developers, privacy, plan) a shared
 * column and tab bar, so related pages read as one place. Other pages render unchanged.
 */
export function SectionFrame({ children }: { children: ReactNode }) {
  const { t } = useTranslation('admin-nav');
  const filter = useNavFilter();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const section = sectionAt(pathname);
  if (!section) return children;
  const admin = filter.role === 'owner' || filter.role === 'admin';
  const tabs = section.tabs({
    admin,
    multiLocation: filter.multiLocation,
    extensionPages: filter.extensionPages,
  });
  const current = currentTabId(tabs, pathname);
  return (
    <div className={`mx-auto flex ${section.width} flex-col gap-6`}>
      {tabs.length > 1 ? (
        <div className="flex flex-col gap-2 print:hidden">
          <TabLinks label={t(`sections.${section.id}`)} tabs={tabs} current={current} />
        </div>
      ) : null}
      {children}
    </div>
  );
}
