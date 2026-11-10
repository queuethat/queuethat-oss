import { createFileRoute } from '@tanstack/react-router';
import { loadNamespaces } from '../../lib/i18n.ts';
import { UsagePage } from '../../features/admin/usage/UsagePage.tsx';

export const Route = createFileRoute('/admin/usage')({
  beforeLoad: () => loadNamespaces('admin-usage'),
  component: UsagePage,
});
