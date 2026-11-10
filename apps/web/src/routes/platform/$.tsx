import { createFileRoute } from '@tanstack/react-router';
import { PlatformPages } from '../../features/platform/pages.tsx';

// Every platform page without a route of its own (see features/platform/pages.tsx). The splat
// has no validateSearch: each page parses the raw query string itself.
export const Route = createFileRoute('/platform/$')({
  component: function PlatformSplat() {
    const { _splat } = Route.useParams();
    return (
      <PlatformPages
        path={(_splat ?? '').replace(/\/+$/, '')}
        search={Route.useSearch() as Record<string, unknown>}
        context={Route.useRouteContext()}
      />
    );
  },
});
