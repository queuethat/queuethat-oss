import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadNamespaces } from '../../../lib/i18n.ts';
import { HELP_ARTICLE_IDS, HelpArticles } from './HelpArticles.tsx';
import { HelpLink } from './HelpLink.tsx';

beforeAll(() => loadNamespaces('admin-support', 'admin-nav'));
afterEach(cleanup);

async function view(ui: React.ReactNode) {
  const router = createRouter({
    routeTree: createRootRoute({ component: () => ui }),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  await router.load();
  return render(<RouterProvider router={router} />);
}

describe('HelpArticles', () => {
  it('renders the seven articles, each with 5 to 8 lines, linked from a contents list', async () => {
    await view(<HelpArticles />);
    expect(HELP_ARTICLE_IDS).toHaveLength(7);
    const contents = await screen.findByRole('navigation', { name: 'Articles' });
    const links = within(contents).getAllByRole('link');
    expect(links.map((a) => a.textContent)).toEqual([
      'Set up a line',
      'Call the next guest',
      'Share the QR code',
      'Text messages (SMS)',
      'Add staff and set roles',
      'Opening hours',
      'Delete guest or account data',
    ]);
    for (const [i, id] of HELP_ARTICLE_IDS.entries()) {
      expect(links[i]!.getAttribute('href')).toBe(`#help-${id}`);
      const article = document.getElementById(`help-${id}`)!;
      const lines = within(article).getAllByRole('listitem').length;
      expect(lines).toBeGreaterThanOrEqual(5);
      expect(lines).toBeLessThanOrEqual(8);
    }
  });

  it('has no accessibility violations', async () => {
    const { container } = await view(<HelpArticles />);
    await screen.findByRole('navigation', { name: 'Articles' });
    const results = await axe.run(container);
    expect(results.violations).toEqual([]);
  });
});

describe('HelpLink', () => {
  it('points at the help section of the Support page and is keyboard reachable', async () => {
    const user = userEvent.setup();
    await view(<HelpLink />);
    const link = await screen.findByRole('link', { name: 'Help' });
    expect(link.getAttribute('href')).toBe('/admin/settings/support#help');
    await user.tab();
    expect(document.activeElement).toBe(link);
  });
});
