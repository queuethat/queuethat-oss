import { createFileRoute } from '@tanstack/react-router';
import { CountersPage } from '../../features/admin/counters/CountersPage.tsx';

export const Route = createFileRoute('/admin/counters')({
  component: CountersPage,
});
