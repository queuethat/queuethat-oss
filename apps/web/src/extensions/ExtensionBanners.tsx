import { lazy, Suspense } from 'react';
import { bannersFor } from './index.ts';

// Built once per area at load: the installed set is fixed for the life of the bundle.
const BANNERS = {
  staff: bannersFor('staff').map((b) => ({ id: b.id, Component: lazy(b.load) })),
  admin: bannersFor('admin').map((b) => ({ id: b.id, Component: lazy(b.load) })),
};

/** Renders the installed extensions' banners for an area. Renders nothing in this repository. */
export function ExtensionBanners({ area }: { area: 'staff' | 'admin' }) {
  const banners = BANNERS[area];
  if (banners.length === 0) return null;
  return (
    <Suspense fallback={null}>
      {banners.map(({ id, Component }) => (
        <Component key={id} />
      ))}
    </Suspense>
  );
}
