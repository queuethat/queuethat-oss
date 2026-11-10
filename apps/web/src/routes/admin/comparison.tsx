import { createFileRoute } from '@tanstack/react-router';
import { ComparisonPage } from '../../features/admin/comparison/ComparisonPage.tsx';

export const Route = createFileRoute('/admin/comparison')({
  component: ComparisonPage,
});
