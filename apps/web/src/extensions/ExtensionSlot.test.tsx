import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  installed: { adminPages: [], banners: [] } as Record<string, unknown>,
}));
vi.mock('./installed.ts', () => ({
  get extensions() {
    return m.installed;
  },
}));

afterEach(cleanup);

describe('ExtensionSlot', () => {
  it('renders its children when nothing is installed for the slot', async () => {
    const { ExtensionSlot } = await import('./ExtensionSlot.tsx');
    render(
      <ExtensionSlot name="limits.reached" props={{ kind: 'members', limit: 3, role: 'owner' }}>
        <p>default message</p>
      </ExtensionSlot>,
    );
    expect(screen.getByText('default message')).toBeTruthy();
  });

  it('renders the installed component with the slot props instead', async () => {
    vi.resetModules();
    m.installed = {
      adminPages: [],
      banners: [],
      slots: {
        'limits.reached': () =>
          Promise.resolve({
            default: ({ kind, limit }: { kind: string; limit?: number }) => (
              <p>{`${kind} limit ${limit}`}</p>
            ),
          }),
      },
    };
    const { ExtensionSlot } = await import('./ExtensionSlot.tsx');
    render(
      <ExtensionSlot name="limits.reached" props={{ kind: 'members', limit: 3, role: 'owner' }}>
        <p>default message</p>
      </ExtensionSlot>,
    );
    expect(await screen.findByText('members limit 3')).toBeTruthy();
    expect(screen.queryByText('default message')).toBeNull();
  });
});
