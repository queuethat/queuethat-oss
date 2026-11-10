import { createFileRoute } from '@tanstack/react-router';
import { loadNamespaces } from '../../../lib/i18n.ts';
import { GuestsPage } from '../../../features/admin/guests/GuestsPage.tsx';

export const Route = createFileRoute('/admin/guests/')({
  beforeLoad: () => loadNamespaces('admin-guests'),
  component: GuestsPage,
});
