import { createFileRoute, lazyRouteComponent, notFound } from '@tanstack/react-router';
import { loadNamespaces } from '../../lib/i18n.ts';

// Fake SMS inbox for development (2P-NTF11, #183). Compiled in only for `pnpm dev` or a build with
// VITE_DEV_INBOX=true: otherwise the condition below is a constant false, the dynamic import is
// dropped, and scripts/check-dev-inbox-bundle.mjs fails the build if any of it remains.
export const Route = createFileRoute('/dev/inbox')({
  beforeLoad: async (args) => {
    if (!(import.meta.env.DEV || import.meta.env.VITE_DEV_INBOX === 'true')) throw notFound();
    const [{ requireMember }] = await Promise.all([
      import('../../features/auth/guard.ts'),
      loadNamespaces('dev-inbox', 'auth'),
    ]);
    await requireMember(args);
  },
  component:
    import.meta.env.DEV || import.meta.env.VITE_DEV_INBOX === 'true'
      ? lazyRouteComponent(() => import('../../features/dev-inbox/InboxPage.tsx'), 'InboxPage')
      : () => null,
});
