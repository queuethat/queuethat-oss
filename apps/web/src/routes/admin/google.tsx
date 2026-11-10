import { createFileRoute } from '@tanstack/react-router';
import { GbpPage } from '../../features/admin/integrations/gbp/GbpPage.tsx';

export const Route = createFileRoute('/admin/google')({
  component: GbpPage,
});
