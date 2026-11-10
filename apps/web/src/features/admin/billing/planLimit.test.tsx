import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadNamespaces } from '../../../lib/i18n.ts';
import { asPlanLimitError, isPlanLimit, PlanLimitError, PlanLimitNotice } from './planLimit.tsx';

beforeAll(() => loadNamespaces('admin-billing'));
afterEach(cleanup);

async function view(ui: React.ReactNode) {
  const router = createRouter({
    routeTree: createRootRoute({ component: () => ui }),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  await router.load();
  render(<RouterProvider router={router} />);
}

describe('PlanLimitNotice', () => {
  it('tells an owner what the plan includes and links to Billing', async () => {
    await view(<PlanLimitNotice kind="members" error={new PlanLimitError(3)} memberRole="owner" />);
    expect(
      await screen.findByText('Your plan includes 3 people. Upgrade to add more.'),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Upgrade' }).getAttribute('href')).toBe(
      '/admin/billing',
    );
  });

  it('uses the singular and the location wording', async () => {
    await view(
      <PlanLimitNotice kind="locations" error={new PlanLimitError(1)} memberRole="owner" />,
    );
    expect(
      await screen.findByText('Your plan includes 1 location. Upgrade to add more.'),
    ).toBeTruthy();
  });

  it('drops the number when the database did not give one', async () => {
    await view(
      <PlanLimitNotice kind="locations" error={new PlanLimitError()} memberRole="owner" />,
    );
    expect(await screen.findByText(/no room for another location/)).toBeTruthy();
  });

  it('sends an admin to an owner instead of a Billing page they cannot open', async () => {
    await view(<PlanLimitNotice kind="members" error={new PlanLimitError(3)} memberRole="admin" />);
    expect(await screen.findByText(/Ask one to upgrade/)).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Upgrade' })).toBeNull();
  });
});

describe('asPlanLimitError', () => {
  it('reads the limit from PostgREST details', () => {
    const e = asPlanLimitError({ message: 'plan_limit_reached', details: '3' });
    expect(e).toBeInstanceOf(PlanLimitError);
    expect(e?.limit).toBe(3);
  });

  it('accepts the code without details and ignores other errors', () => {
    expect(asPlanLimitError({ message: 'plan_limit_reached' })?.limit).toBeUndefined();
    expect(asPlanLimitError({ message: 'not_found' })).toBeNull();
    expect(isPlanLimit(new Error('plan_limit_reached'))).toBe(true);
    expect(isPlanLimit(new Error('x'))).toBe(false);
  });
});
