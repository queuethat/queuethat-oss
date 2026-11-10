import { createFileRoute } from '@tanstack/react-router';
import { loadNamespaces } from '../../lib/i18n.ts';
import { StaffLayout } from '../../layouts/StaffLayout.tsx';

// Signed-in users with no organization land here. Outside /admin so its guard can't loop.
export const Route = createFileRoute('/onboarding')({
  beforeLoad: async (args) => {
    const [{ requireNonMember }] = await Promise.all([
      import('../../features/auth/guard.ts'),
      loadNamespaces('onboarding', 'auth'),
    ]);
    await requireNonMember(args);
  },
  component: () => <StaffLayout area="onboarding" />,
});
