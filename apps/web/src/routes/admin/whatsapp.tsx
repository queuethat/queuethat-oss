import { createFileRoute } from '@tanstack/react-router';
import { loadNamespaces } from '../../lib/i18n.ts';
import { WhatsAppPage } from '../../features/admin/integrations/whatsapp/WhatsAppPage.tsx';

export const Route = createFileRoute('/admin/whatsapp')({
  beforeLoad: () => loadNamespaces('admin-whatsapp'),
  component: WhatsAppPage,
});
