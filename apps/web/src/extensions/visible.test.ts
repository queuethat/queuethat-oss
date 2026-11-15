import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { WebExtensions } from './types.ts';
import { useVisibleExtensionPages } from './visible.ts';

const load = () => Promise.resolve({ default: () => null });

describe('useVisibleExtensionPages', () => {
  it('offers every page without a hook, and asks each hook with the member', () => {
    const useVisible = vi.fn((who: { role: string | undefined }) => who.role === 'owner');
    const set: WebExtensions = {
      adminPages: [
        { path: 'open', load },
        { path: 'owners', load, useVisible },
      ],
      banners: [],
    };
    const owner = renderHook(() => useVisibleExtensionPages({ orgId: 'o', role: 'owner' }, set));
    expect([...owner.result.current]).toEqual(['open', 'owners']);
    expect(useVisible).toHaveBeenCalledWith({ orgId: 'o', role: 'owner' });
    const staff = renderHook(() => useVisibleExtensionPages({ orgId: 'o', role: 'staff' }, set));
    expect([...staff.result.current]).toEqual(['open']);
  });

  it('offers nothing in this repository', () => {
    const { result } = renderHook(() => useVisibleExtensionPages({ orgId: 'o', role: 'owner' }));
    expect(result.current.size).toBe(0);
  });
});
