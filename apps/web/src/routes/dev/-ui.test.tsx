import { QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { cleanup, render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, describe, expect, it } from 'vitest';
import { queryClient } from '../../lib/query.ts';
import { createAppRouter } from '../../router.tsx';

afterEach(cleanup);

// AC 2 of #18. jsdom has no layout, so axe reports colour contrast as "incomplete" here; the
// real-browser run (light and dark) is in the PR and the e2e suite.
describe('/dev/ui', () => {
  it('has no serious or critical axe violations', async () => {
    const router = createAppRouter(createMemoryHistory({ initialEntries: ['/dev/ui'] }));
    await router.load();
    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await screen.findByRole('heading', { name: 'UI catalogue' });

    const results = await axe.run(container);
    const blocking = results.violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
    expect(blocking).toEqual([]);
  });
});
