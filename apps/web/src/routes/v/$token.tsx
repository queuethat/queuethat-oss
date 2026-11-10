import { createFileRoute } from '@tanstack/react-router';
import { Branded } from '../../features/branding/Branded.tsx';
import { lastJoinPage } from '../../features/guest/api.ts';
import { StatusPage } from '../../features/guest/StatusPage.tsx';

export const Route = createFileRoute('/v/$token')({
  component: function Status() {
    const { token } = Route.useParams();
    // The status has no slug of its own: this browser's last join page brands it. A link opened
    // on another device keeps the default theme.
    return (
      <Branded slug={lastJoinPage()}>
        <StatusPage token={token} />
      </Branded>
    );
  },
});
