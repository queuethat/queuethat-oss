import { createFileRoute } from '@tanstack/react-router';
import { ExportPage } from '../../features/admin/export/ExportPage.tsx';

export const Route = createFileRoute('/admin/export')({
  component: ExportPage,
});
