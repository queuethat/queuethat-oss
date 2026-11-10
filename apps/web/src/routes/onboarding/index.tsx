import { createFileRoute } from '@tanstack/react-router';
import { Wizard } from '../../features/onboarding/Wizard.tsx';

export const Route = createFileRoute('/onboarding/')({
  component: Wizard,
});
