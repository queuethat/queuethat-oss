import { createFileRoute } from '@tanstack/react-router';
import { HeatmapPage } from '../../features/admin/heatmap/HeatmapPage.tsx';

export const Route = createFileRoute('/admin/heatmap')({
  component: HeatmapPage,
});
