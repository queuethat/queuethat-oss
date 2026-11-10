import { Outlet } from '@tanstack/react-router';
import type { ReactNode } from 'react';

/** Guest pages (/q, /v, /u): single mobile column, no navigation, nothing to sign into. */
export function GuestLayout({ children }: { children?: ReactNode }) {
  return (
    <div className="layout-guest" data-layout="guest">
      <main>{children ?? <Outlet />}</main>
    </div>
  );
}
