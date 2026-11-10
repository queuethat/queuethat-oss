import { createFileRoute } from '@tanstack/react-router';
import { loadNamespaces } from '../../lib/i18n.ts';
import { DomainsPage } from '../../features/admin/domains/DomainsPage.tsx';

export const Route = createFileRoute('/admin/domains')({
  beforeLoad: () => loadNamespaces('admin-domains'),
  component: DomainsPage,
});
