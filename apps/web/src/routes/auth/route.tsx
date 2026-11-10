import { createFileRoute } from '@tanstack/react-router';
import { loadNamespaces } from '../../lib/i18n.ts';
import { StaffLayout } from '../../layouts/StaffLayout.tsx';

export const Route = createFileRoute('/auth')({
  beforeLoad: () => loadNamespaces('auth'),
  component: () => <StaffLayout area="auth" />,
});
