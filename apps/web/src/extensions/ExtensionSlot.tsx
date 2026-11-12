import { lazy, Suspense, type ComponentType, type ReactNode } from 'react';
import { installedExtensions } from './index.ts';
import type { ExtensionSlotName, ExtensionSlotProps } from './types.ts';

// Built once at load: the installed set is fixed for the life of the bundle.
const SLOTS: Partial<Record<ExtensionSlotName, ComponentType<object>>> = Object.fromEntries(
  Object.entries(installedExtensions().slots ?? {}).map(([name, load]) => [
    name,
    lazy(load as () => Promise<{ default: ComponentType<object> }>),
  ]),
);

/**
 * Renders the installed extension's component for a slot, or `children` when none is installed
 * (this repository installs none). The extension replaces `children`; it loads only when shown.
 */
export function ExtensionSlot<K extends ExtensionSlotName>({
  name,
  props,
  children = null,
}: {
  name: K;
  props: ExtensionSlotProps[K];
  children?: ReactNode;
}) {
  const Slot = SLOTS[name] as ComponentType<ExtensionSlotProps[K]> | undefined;
  if (!Slot) return <>{children}</>;
  return (
    <Suspense fallback={null}>
      <Slot {...props} />
    </Suspense>
  );
}
