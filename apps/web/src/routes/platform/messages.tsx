import { createFileRoute } from '@tanstack/react-router';
import { MessagesPage } from '../../features/platform/deliveries/MessagesPage.tsx';

export const Route = createFileRoute('/platform/messages')({
  component: function Messages() {
    return <MessagesPage />;
  },
});
