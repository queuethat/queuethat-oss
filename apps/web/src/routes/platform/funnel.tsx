import { createFileRoute } from '@tanstack/react-router';
import { FunnelPage } from '../../features/platform/FunnelPage.tsx';
import { parseFunnelSearch } from '../../features/platform/funnel.ts';

export const Route = createFileRoute('/platform/funnel')({
  validateSearch: parseFunnelSearch,
  component: function Funnel() {
    return <FunnelPage filter={parseFunnelSearch(Route.useSearch())} />;
  },
});
