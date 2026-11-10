import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { AppShell } from './AppShell.tsx';
import { PageHeader } from './PageHeader.tsx';
import { SectionNav, type NavGroup } from './SectionNav.tsx';

afterEach(cleanup);

const groups: NavGroup[] = [
  {
    id: 'today',
    label: 'Today',
    items: [
      { id: 'today', label: 'Today' },
      { id: 'queues', label: 'Queues' },
    ],
  },
  { id: 'setup', label: 'Set up', items: [{ id: 'hours', label: 'Hours' }] },
  { id: 'danger', items: [{ id: 'danger', label: 'Danger zone' }] },
];

function Nav({ currentId }: { currentId?: string }) {
  return (
    <SectionNav
      label="Admin"
      groups={groups}
      currentId={currentId}
      renderItem={(item, view) => (
        <a
          href={`#${item.id}`}
          className={view.className}
          aria-current={view.current ? 'page' : undefined}
        >
          {view.content}
        </a>
      )}
    />
  );
}

describe('SectionNav', () => {
  it('opens only the group holding the current page and toggles others', async () => {
    render(<Nav currentId="hours" />);
    expect(screen.getByRole('button', { name: 'Set up' }).getAttribute('aria-expanded')).toBe(
      'true',
    );
    expect(screen.getByRole('button', { name: 'Today' }).getAttribute('aria-expanded')).toBe(
      'false',
    );
    expect(screen.queryByRole('link', { name: 'Queues' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Hours' }).getAttribute('aria-current')).toBe('page');

    await userEvent.setup().click(screen.getByRole('button', { name: 'Today' }));
    expect(screen.getByRole('link', { name: 'Queues' })).toBeTruthy();
  });

  it('remembers the open and closed choices per browser when given a storageKey', async () => {
    localStorage.clear();
    const user = userEvent.setup();
    const view = render(
      <SectionNav
        label="Admin"
        storageKey="test-nav"
        groups={groups}
        renderItem={(item, v) => <a href={`#${item.id}`}>{v.content}</a>}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Today' }));
    view.unmount();
    render(
      <SectionNav
        label="Admin"
        storageKey="test-nav"
        groups={groups}
        renderItem={(item, v) => <a href={`#${item.id}`}>{v.content}</a>}
      />,
    );
    expect(screen.getByRole('button', { name: 'Today' }).getAttribute('aria-expanded')).toBe(
      'true',
    );
    localStorage.clear();
  });

  it('always shows an unlabelled group and reopens the group of a new current page', () => {
    const { rerender } = render(<Nav currentId="hours" />);
    expect(screen.getByRole('link', { name: 'Danger zone' })).toBeTruthy();
    rerender(<Nav currentId="queues" />);
    expect(screen.getByRole('link', { name: 'Queues' })).toBeTruthy();
  });

  it('is reachable by keyboard', async () => {
    render(<Nav currentId="hours" />);
    const user = userEvent.setup();
    await user.tab();
    expect(document.activeElement?.textContent).toContain('Today');
    await user.keyboard('{Enter}');
    expect(screen.getByRole('link', { name: 'Queues' })).toBeTruthy();
  });
});

describe('AppShell and PageHeader', () => {
  function Page() {
    return (
      <AppShell
        nav={({ close }) => (
          <a href="#x" onClick={close}>
            Go
          </a>
        )}
        menuLabel="Menu"
        skipLabel="Skip to content"
        sidebarLabel="Sidebar"
      >
        <PageHeader
          title="Today"
          description="Live numbers"
          actions={<button type="button">Add</button>}
        />
      </AppShell>
    );
  }

  it('exposes skip link, complementary, main and a single h1', () => {
    render(<Page />);
    expect(screen.getByRole('link', { name: 'Skip to content' }).getAttribute('href')).toBe(
      '#main-content',
    );
    expect(screen.getByRole('complementary', { name: 'Sidebar' })).toBeTruthy();
    expect(screen.getByRole('main').id).toBe('main-content');
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('Escape closes the drawer and returns focus to the menu button', async () => {
    render(<Page />);
    const user = userEvent.setup();
    const button = screen.getByRole('button', { name: 'Menu' });
    await user.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    await user.tab();
    await user.keyboard('{Escape}');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(button);
  });

  it('renders breadcrumbs as a labelled list, last crumb unlinked', () => {
    render(
      <PageHeader
        title="Hours"
        breadcrumbs={[{ label: 'Location', to: '/admin/location' }, { label: 'Hours' }]}
        breadcrumbLabel="Breadcrumb"
        renderCrumb={(c) => <a href={c.to}>{c.label}</a>}
      />,
    );
    const nav = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(nav.querySelectorAll('a')).toHaveLength(1);
  });
});
