import { createFileRoute } from '@tanstack/react-router';
import { loadNamespaces } from '../../../lib/i18n.ts';
import { PrivacyPage } from '../../../features/admin/privacy/PrivacyPage.tsx';

export const Route = createFileRoute('/admin/privacy/')({
  beforeLoad: () => loadNamespaces('admin-privacy'),
  component: PrivacyPage,
});
