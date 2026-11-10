import { createFileRoute } from '@tanstack/react-router';
import { OrgDetail } from '../../../features/platform/OrgDetail.tsx';

export const Route = createFileRoute('/platform/orgs/$orgId')({
  component: function OrgPage() {
    const { platformRole } = Route.useRouteContext();
    return <OrgDetail orgId={Route.useParams().orgId} canAct={platformRole === 'operator'} />;
  },
});
