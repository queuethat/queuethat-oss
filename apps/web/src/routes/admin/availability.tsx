import { createFileRoute } from '@tanstack/react-router';
import { AvailabilityPage } from '../../features/admin/availability/AvailabilityPage.tsx';

export const Route = createFileRoute('/admin/availability')({
  component: AvailabilityPage,
});
