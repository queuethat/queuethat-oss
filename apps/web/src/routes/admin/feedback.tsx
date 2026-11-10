import { createFileRoute } from '@tanstack/react-router';
import { FeedbackPage } from '../../features/admin/feedback/FeedbackPage.tsx';

export const Route = createFileRoute('/admin/feedback')({
  component: FeedbackPage,
});
