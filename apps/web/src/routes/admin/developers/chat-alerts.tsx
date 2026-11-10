import { createFileRoute } from '@tanstack/react-router';
import { loadNamespaces } from '../../../lib/i18n.ts';
import { ChatAlertsPage } from '../../../features/admin/developers/chat-alerts/ChatAlertsPage.tsx';

export const Route = createFileRoute('/admin/developers/chat-alerts')({
  beforeLoad: () => loadNamespaces('admin-chat-alerts'),
  component: ChatAlertsPage,
});
