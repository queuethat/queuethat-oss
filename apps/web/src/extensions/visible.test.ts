import { describe, expect, it } from 'vitest';
import type { WebExtensions } from './types.ts';
import { visibleExtensionPages } from './visible.ts';

const load = () => Promise.resolve({ default: () => null });

describe('visibleExtensionPages', () => {
  it('offers a page without roles to everyone, and one with roles only to those roles', () => {
    const set: WebExtensions = {
      adminPages: [
        { path: 'open', load },
        { path: 'owners', load, roles: ['owner'] },
      ],
      banners: [],
    };
    expect([...visibleExtensionPages('owner', set)]).toEqual(['open', 'owners']);
    expect([...visibleExtensionPages('staff', set)]).toEqual(['open']);
    expect([...visibleExtensionPages(undefined, set)]).toEqual(['open']);
  });

  it('offers nothing in this repository', () => {
    expect(visibleExtensionPages('owner').size).toBe(0);
  });
});
