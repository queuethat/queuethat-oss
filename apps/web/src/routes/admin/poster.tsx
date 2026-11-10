import { createFileRoute } from '@tanstack/react-router';
import { PosterPage } from '../../features/admin/poster/PosterPage.tsx';

export const Route = createFileRoute('/admin/poster')({
  component: PosterPage,
});
