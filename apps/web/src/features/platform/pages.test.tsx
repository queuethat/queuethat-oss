import { isNotFound } from '@tanstack/react-router';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PlatformPages } from './pages.tsx';

// The pages themselves are tested in ops/; here they are stand-ins that show they were chosen.
vi.mock('./audit/AuditPage.tsx', () => ({
  AuditPage: ({ filter, canSeeAll }: { filter: { org?: string }; canSeeAll: boolean }) => (
    <p>
      audit page {String(canSeeAll)} {filter.org ?? 'no org'}
    </p>
  ),
}));
vi.mock('./ops/HealthPage.tsx', () => ({ HealthPage: () => <p>health page</p> }));
vi.mock('./ops/StatsPage.tsx', () => ({ StatsPage: () => <p>stats page</p> }));
vi.mock('./ops/BlocksPage.tsx', () => ({ BlocksPage: () => <p>blocks page</p> }));
vi.mock('./ops/AnnouncementsPage.tsx', () => ({
  AnnouncementsPage: () => <p>announcements page</p>,
}));

vi.mock('./VisitLookup.tsx', () => ({
  VisitLookup: ({ orgId }: { orgId: string }) => <p>{`visit lookup ${orgId}`}</p>,
}));

const operator = { platformRole: 'operator' } as const;
const ORG = '123e4567-e89b-42d3-a456-426614174000';

describe('PlatformPages', () => {
  it('audit gets its parsed filters, and only operators see everyone', () => {
    const { unmount } = render(
      <PlatformPages path="audit" search={{ org: ORG, junk: 1 }} context={operator} />,
    );
    expect(screen.getByText(`audit page true ${ORG}`)).toBeTruthy();
    unmount();
    render(
      <PlatformPages path="audit" search={{ org: 'bad' }} context={{ platformRole: 'support' }} />,
    );
    expect(screen.getByText('audit page false no org')).toBeTruthy();
  });

  it.each(['health', 'stats', 'blocks', 'announcements'])('renders the %s page', (path) => {
    render(<PlatformPages path={path} search={{}} context={operator} />);
    expect(screen.getByText(`${path} page`)).toBeTruthy();
  });

  it.each(['', 'nope', 'health/extra', 'Health', 'constructor', '__proto__', 'toString'])(
    'answers %j with the 404, not a page',
    (path) => {
      let thrown: unknown;
      try {
        render(<PlatformPages path={path} search={{}} context={operator} />);
      } catch (error) {
        thrown = error;
      }
      expect(isNotFound(thrown)).toBe(true);
    },
  );

  it('opens the visit lookup for the org in the query string', () => {
    render(<PlatformPages path="visits" search={{ org: ORG }} context={operator} />);
    expect(screen.getByText(`visit lookup ${ORG}`)).toBeTruthy();
  });

  it.each([{}, { org: '' }, { org: 'not-a-uuid' }, { org: ['a', 'b'] }, { org: 7 }])(
    'answers the visit lookup with %j with the 404',
    (search) => {
      let thrown: unknown;
      try {
        render(<PlatformPages path="visits" search={search} context={operator} />);
      } catch (error) {
        thrown = error;
      }
      expect(isNotFound(thrown)).toBe(true);
    },
  );
});
