import { lazy, Suspense, type ReactNode } from 'react';

// Everything about branding loads after the page renders, so the guest route budget does not pay
// for it. The page itself is never wrapped: header and footer are siblings, and the colours are
// custom properties on the root.
const BrandHeader = lazy(() =>
  import('./BrandParts.tsx').then((m) => ({ default: m.BrandHeader })),
);
const BrandFooter = lazy(() =>
  import('./BrandParts.tsx').then((m) => ({ default: m.BrandFooter })),
);

/**
 * The business's look around a guest page: its colours, a header with logo, name and welcome text,
 * and legal links below. With no slug, no branding or a failed fetch the page stays in the default
 * theme. The footer's source link (AGPL-3.0 s13) is there in every case.
 */
export function Branded({ slug, children }: { slug: string | null; children: ReactNode }) {
  return (
    <>
      <Suspense fallback={null}>
        <BrandHeader slug={slug} />
      </Suspense>
      {children}
      <Suspense fallback={null}>
        <BrandFooter slug={slug} />
      </Suspense>
    </>
  );
}
