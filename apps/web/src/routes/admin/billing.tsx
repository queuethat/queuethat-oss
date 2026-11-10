import { createFileRoute } from '@tanstack/react-router';
import { loadNamespaces } from '../../lib/i18n.ts';
import { BillingPage } from '../../features/admin/billing/BillingPage.tsx';

export const Route = createFileRoute('/admin/billing')({
  beforeLoad: () => loadNamespaces('admin-billing'),
  component: BillingPage,
});
