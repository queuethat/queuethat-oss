import { lazy, Suspense } from 'react';
import { bannersFor } from './index.ts';
import type { ExtensionBannerArea } from './types.ts';

// Built once per area at load: the installed set is fixed for the life of the bundle.
const AREAS: ExtensionBannerArea[] = ['staff', 'admin', 'onboarding'];
const BANNERS = Object.fromEntries(
  AREAS.map((area) => [area, bannersFor(area).map((b) => ({ id: b.id, Component: lazy(b.load) }))]),
) as Record<ExtensionBannerArea, { id: string; Component: ReturnType<typeof lazy> }[]>;

/** Renders the installed extensions' banners for an area. Renders nothing in this repository. */
export function ExtensionBanners({ area }: { area: ExtensionBannerArea }) {
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
