import { createFileRoute } from '@tanstack/react-router';
import { loadNamespaces } from '../../lib/i18n.ts';
import { StaffLayout } from '../../layouts/StaffLayout.tsx';

export const Route = createFileRoute('/admin')({
  // Dynamic import: the guard pulls in the Supabase client, which guest pages must not load.
  beforeLoad: async (args) => {
    const [{ requireMember }] = await Promise.all([
      import('../../features/auth/guard.ts'),
      loadNamespaces(
        'admin',
        'admin-nav',
        'admin-setup',
        'empty',
        'auth',
        'appointments',
        'account',
      ),
    ]);
    await requireMember(args);
  },
  component: () => <StaffLayout area="admin" />,
});
