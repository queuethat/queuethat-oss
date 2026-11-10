import type { ReactNode } from 'react';
import { notFound } from '@tanstack/react-router';
import { AuditPage } from './audit/AuditPage.tsx';
import { parseAuditSearch } from './audit/search.ts';
import { AnnouncementsPage } from './ops/AnnouncementsPage.tsx';
import { BlocksPage } from './ops/BlocksPage.tsx';
import { HealthPage } from './ops/HealthPage.tsx';
import { StatsPage } from './ops/StatsPage.tsx';
import { IncidentsPage } from './incidents/IncidentsPage.tsx';
import { VisitLookup } from './VisitLookup.tsx';

/**
 * The platform console's pages that need no route of their own, by the path after `/platform/`.
 * Served by the one `/platform/$` route, which is code-split, so a page added here costs the
 * guest root chunk nothing (every file route adds about 0.1 KB gzip there, and the guest budget
 * has almost no headroom). Add a page by adding a line here and a nav link built with
 * `{ to: '/platform/$', params: { _splat: '<path>' } }`. A page gets the raw query string (parse
 * it with the page's own parser) and the viewer's platform role. Pages with a path parameter, their own guard or a typed search keep
 * a file route.
 */
/** What the console knows about the viewer. */
export interface PlatformContext {
  platformRole: 'support' | 'operator' | null | undefined;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PAGES: Record<
  string,
  (search: Record<string, unknown>, context: PlatformContext) => ReactNode
> = {
  audit: (search, { platformRole }) => (
    <AuditPage filter={parseAuditSearch(search)} canSeeAll={platformRole === 'operator'} />
  ),
  health: () => <HealthPage />,
  stats: () => <StatsPage />,
  blocks: () => <BlocksPage />,
  announcements: () => <AnnouncementsPage />,
  incidents: () => <IncidentsPage />,
  // #1136: the tenant comes in the query string (`?org=<uuid>`); anything else is the 404 page.
  visits: (search) => {
    const org = typeof search.org === 'string' ? search.org : '';
    if (!UUID.test(org)) throw notFound();
    return <VisitLookup orgId={org} />;
  },
};

/** Renders the registered page for `path`, or the app's 404 for anything else. */
export function PlatformPages({
  path,
  search,
  context,
}: {
  path: string;
  search: Record<string, unknown>;
  context: PlatformContext;
}) {
  const render = Object.hasOwn(PAGES, path) ? PAGES[path] : undefined;
  if (!render) throw notFound();
  return render(search, context);
}
