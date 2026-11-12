import { createElement, lazy, Suspense } from 'react';
import { installedExtensions } from './index.ts';

// One lazy component per installed page, built once at load.
const PAGES = new Map(installedExtensions().adminPages.map((p) => [p.path, lazy(p.load)]));

/** Renders an installed extension's admin page, loading its module on first open. */
export function ExtensionAdminPage({ path }: { path: string }) {
  const page = PAGES.get(path);
  // createElement: the component is one of the module-level lazies above, not made per render.
  return page ? <Suspense fallback={null}>{createElement(page)}</Suspense> : null;
}
