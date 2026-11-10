import { createFileRoute } from '@tanstack/react-router';
import { CalendarFeedPage } from '../../../features/account/calendar/CalendarFeedPage.tsx';

export const Route = createFileRoute('/admin/account/calendar')({
  component: CalendarFeedPage,
});
