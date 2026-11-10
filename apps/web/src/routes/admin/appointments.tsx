import { createFileRoute } from '@tanstack/react-router';
import { AgendaPage } from '../../features/appointments/AgendaPage.tsx';

export const Route = createFileRoute('/admin/appointments')({
  component: AgendaPage,
});
