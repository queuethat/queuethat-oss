import type { ReactNode } from 'react';
import { DeviceProductLine } from '../features/branding/DeviceProductLine.tsx';

/** TV display and kiosk: full screen, no chrome, legible from across a room. */
export function DisplayLayout({
  kind,
  children,
}: {
  kind: 'display' | 'kiosk';
  children: ReactNode;
}) {
  return (
    <div className="layout-display" data-layout={kind}>
      <main>{children}</main>
      <DeviceProductLine />
    </div>
  );
}
