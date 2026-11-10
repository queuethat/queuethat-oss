import { createFileRoute } from '@tanstack/react-router';
import { PlanningPage } from '../../features/planning/PlanningPage.tsx';

export const Route = createFileRoute('/staff/planning')({
  component: PlanningPage,
});
