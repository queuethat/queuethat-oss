import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { UnreadChatProvider } from '../../features/console/chat/Unread.tsx';
import { ConsolePage } from '../../features/console/ConsolePage.tsx';

export const Route = createFileRoute('/staff/')({
  validateSearch: (search: Record<string, unknown>): { queue?: string } =>
    typeof search.queue === 'string' ? { queue: search.queue } : {},
  component: StaffConsole,
});

function StaffConsole() {
  const { queue } = Route.useSearch();
  const navigate = useNavigate({ from: '/staff/' });
  return (
    <UnreadChatProvider>
      <ConsolePage
        queueId={queue}
        onQueueChange={(id) => void navigate({ search: { queue: id }, replace: true })}
      />
    </UnreadChatProvider>
  );
}
