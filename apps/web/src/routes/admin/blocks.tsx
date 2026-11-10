import { createFileRoute } from '@tanstack/react-router';
import { loadNamespaces } from '../../lib/i18n.ts';
import { BlocksPage } from '../../features/admin/blocks/BlocksPage.tsx';

export const Route = createFileRoute('/admin/blocks')({
  beforeLoad: () => loadNamespaces('admin-privacy'),
  component: BlocksPage,
});
