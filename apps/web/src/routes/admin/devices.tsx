import { createFileRoute } from '@tanstack/react-router';
import { DevicesPage } from '../../features/admin/devices/DevicesPage.tsx';

export const Route = createFileRoute('/admin/devices')({
  component: DevicesPage,
});
