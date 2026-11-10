import { createFileRoute } from '@tanstack/react-router';
import { TeamPage } from '../../features/platform/team/TeamPage.tsx';

export const Route = createFileRoute('/platform/team')({
  component: function Team() {
    return <TeamPage />;
  },
});
