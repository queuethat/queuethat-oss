import { createFileRoute } from '@tanstack/react-router';
import { loadNamespaces } from '../../../lib/i18n.ts';
import { ApiKeysPage } from '../../../features/admin/developers/api-keys/ApiKeysPage.tsx';

export const Route = createFileRoute('/admin/developers/api-keys')({
  beforeLoad: () => loadNamespaces('admin-api-keys'),
  component: ApiKeysPage,
});
