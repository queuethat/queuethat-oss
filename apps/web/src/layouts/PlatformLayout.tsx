import { ToastProvider } from '@qm/ui';
import { Outlet, useRouteContext } from '@tanstack/react-router';
import { useTranslation } from '../lib/translation.tsx';
import { SessionLimits } from '../features/auth/SessionLimits.tsx';
import { SignOutButton } from '../features/auth/SignOutButton.tsx';
import { PlatformNav } from '../features/platform/nav/PlatformNav.tsx';

/**
 * The operator console (PLT10): desktop-first, its own nav, no tenant location switcher. An
 * account without a platform role only ever sees /platform/mfa here, so it gets no nav.
 */
export function PlatformLayout() {
  const { platformRole } = useRouteContext({ from: '/platform' });
  const common = useTranslation('common').t;
  return (
    <ToastProvider
      regionLabel={common('toast.region')}
      dismissLabel={common('toast.dismiss')}
      undoLabel={common('toast.undo')}
    >
      <div className="layout-staff" data-layout="platform">
        <SessionLimits />
        <header className="flex flex-col-reverse gap-3 px-6 pt-4 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
          {platformRole ? <PlatformNav role={platformRole} /> : <span />}
          <div className="self-end sm:self-start">
            <SignOutButton />
          </div>
        </header>
        <main>
          <Outlet />
        </main>
      </div>
    </ToastProvider>
  );
}
