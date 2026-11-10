import { createFileRoute } from '@tanstack/react-router';
import { EtaAccuracyPage } from '../../features/admin/eta-accuracy/EtaAccuracyPage.tsx';

export const Route = createFileRoute('/admin/eta-accuracy')({
  component: EtaAccuracyPage,
});
