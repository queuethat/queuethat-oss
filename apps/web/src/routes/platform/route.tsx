import { createFileRoute, notFound, redirect } from '@tanstack/react-router';
import { PlatformLayout } from '../../layouts/PlatformLayout.tsx';
import { loadNamespaces } from '../../lib/i18n.ts';

// PLT10 (#416): every /platform page. Anyone without a platform role gets the 404 page, except
// on /platform/mfa, where any signed-in account may set up its app before being granted a role
// (see mfa.tsx). An operator whose session isn't aal2 yet goes there before any console data loads.
export const Route = createFileRoute('/platform')({
  beforeLoad: async (args) => {
    // Dynamic imports: the guard pulls in the Supabase client, which guest pages must not load.
    const [{ requireSession }, { platformRoleQuery }, { mfaStatusQuery }] = await Promise.all([
      import('../../features/auth/guard.ts'),
      import('../../features/platform/api.ts'),
      import('../../features/auth/mfa/api.ts'),
      loadNamespaces('platform', 'auth'),
    ]);
    const session = await requireSession(args);
    const { queryClient } = args.context;
    const platformRole = await queryClient.fetchQuery(platformRoleQuery(session.user.id));
    if (args.location.pathname === '/platform/mfa') return { platformRole };
    if (!platformRole) throw notFound();
    const mfa = await queryClient.fetchQuery(mfaStatusQuery);
    if (mfa.level !== 'aal2') {
      throw redirect({ to: '/platform/mfa', search: { next: args.location.href } });
    }
    return { platformRole };
  },
  component: PlatformLayout,
});
