import { Link, useRouterState } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { useTranslation } from '../../../lib/translation.tsx';
import { useNavFilter } from '../layout/navModel.ts';
import { currentTabId, reportTabs, sectionAt, type SectionTab } from './sectionTabs.ts';

const BASE =
  'inline-flex min-h-target items-center rounded-control px-4 font-semibold transition-colors';
const LOOK = {
  tab: {
    on: 'bg-primary text-on-primary',
    off: 'bg-secondary text-on-secondary hover:bg-secondary-hover',
  },
  sub: {
    on: 'bg-secondary text-on-secondary underline underline-offset-4',
    off: 'text-muted hover:bg-secondary',
  },
};

function TabLinks({
  label,
  tabs,
  current,
  quiet,
}: {
  label: string;
  tabs: SectionTab[];
  current: string | undefined;
  quiet?: boolean;
}) {
  const { t } = useTranslation('admin-nav');
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
                className={`${BASE} ${LOOK[quiet ? 'sub' : 'tab'][selected ? 'on' : 'off']}`}
              >
                {t(tab.labelKey)}
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
 * column and tab bar, so related pages read as one place. A report page also gets a second row
 * for scheduled, custom and asked reports. Other pages render unchanged.
 */
export function SectionFrame({ children }: { children: ReactNode }) {
  const { t } = useTranslation('admin-nav');
  const filter = useNavFilter();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const section = sectionAt(pathname);
  if (!section) return children;
  const admin = filter.role === 'owner' || filter.role === 'admin';
  const tabs = section.tabs({ admin, multiLocation: filter.multiLocation });
  const current = currentTabId(tabs, pathname);
  return (
    <div className={`mx-auto flex ${section.width} flex-col gap-6`}>
      {tabs.length > 1 ? (
        <div className="flex flex-col gap-2 print:hidden">
          <TabLinks label={t(`sections.${section.id}`)} tabs={tabs} current={current} />
          {current === 'reports' ? (
            <TabLinks
              label={t('insights.reportsLabel')}
              tabs={reportTabs(admin)}
              current={currentTabId(reportTabs(admin), pathname)}
              quiet
            />
          ) : null}
        </div>
      ) : null}
      {children}
    </div>
  );
}
