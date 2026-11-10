import { ToastProvider } from '@qm/ui';
import { Outlet } from '@tanstack/react-router';
import { useTranslation } from '../lib/translation.tsx';
import { BrandLink } from './BrandLink.tsx';
import { Announcements } from '../features/announcements/Announcements.tsx';
import { LocationSwitcher } from '../features/auth/LocationSwitcher.tsx';
import { OperatorChip } from '../features/operator/OperatorChip.tsx';
import { SessionLimits } from '../features/auth/SessionLimits.tsx';
import { ChangePasswordLink } from '../features/auth/ChangePasswordLink.tsx';
import { SignOutButton } from '../features/auth/SignOutButton.tsx';
import { MfaRequiredBanner } from '../features/auth/mfa/MfaRequiredBanner.tsx';
import { AdminShell } from '../features/admin/layout/AdminShell.tsx';
import { IncidentBanner } from '../features/admin/privacy/incidents/IncidentBanner.tsx';
import { PastDueBanner } from '../features/admin/billing/PastDueBanner.tsx';
import { DeletionBanner } from '../features/admin/settings/danger/DeletionBanner.tsx';
import { SuspendedBanner } from '../features/admin/support/SuspendedBanner.tsx';
import { SupportBanner } from '../features/admin/support/SupportBanner.tsx';
import { HelpLink } from '../features/admin/support/HelpLink.tsx';
import { ContactSupportButton } from '../features/admin/support/ContactSupport.tsx';

/** Staff console and admin: tablet-first (768-1280px), large targets. */
export function StaffLayout({ area }: { area: 'staff' | 'admin' | 'onboarding' | 'auth' }) {
  const { t } = useTranslation('common');
  return (
    <ToastProvider
      regionLabel={t('toast.region')}
      dismissLabel={t('toast.dismiss')}
      undoLabel={t('toast.undo')}
    >
      <div className="layout-staff" data-layout={area}>
        {area === 'auth' ? null : <SessionLimits />}
        {area === 'auth' ? null : (
          // Printed pages (the QR poster) are just the page.
          <div className="print:hidden">
            <Announcements />
            {area === 'staff' || area === 'admin' ? (
              <>
                {area === 'admin' ? <DeletionBanner /> : null}
                {area === 'admin' ? <PastDueBanner /> : null}
                {area === 'admin' ? <IncidentBanner /> : null}
                <SuspendedBanner />
                <SupportBanner />
                <MfaRequiredBanner />
              </>
            ) : null}
            <header className="flex flex-col gap-3 px-6 pt-4 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
              {/* Brand over the location, not beside it: side by side it pushed the one-row header past its
                  width at 1280 px and dropped Sign out to a second row. */}
              <div className="flex flex-col items-start gap-1">
                <BrandLink linked={area !== 'onboarding'} />
                {area === 'onboarding' ? null : <LocationSwitcher />}
              </div>
              <div className="flex flex-wrap items-center gap-2 sm:justify-end sm:gap-3">
                {area === 'staff' || area === 'admin' ? <OperatorChip /> : null}
                {area === 'admin' ? <HelpLink /> : null}
                <ContactSupportButton />
                <ChangePasswordLink />
                <SignOutButton />
              </div>
            </header>
          </div>
        )}
        {area === 'admin' ? (
          <div className="px-6 pt-2 print:p-0">
            <AdminShell>
              <Outlet />
            </AdminShell>
          </div>
        ) : (
          <main>
            <Outlet />
          </main>
        )}
      </div>
    </ToastProvider>
  );
}
