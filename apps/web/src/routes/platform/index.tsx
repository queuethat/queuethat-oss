import { createFileRoute } from '@tanstack/react-router';
import { Directory } from '../../features/platform/Directory.tsx';
import { parseDirectorySearch } from '../../features/platform/search.ts';

// The router merges the raw query string under what validateSearch returns, so a key dropped
// there is still present in useSearch(). Sanitizing again in the component is what drops it.
export const Route = createFileRoute('/platform/')({
  validateSearch: parseDirectorySearch,
  component: function DirectoryPage() {
    return <Directory filter={parseDirectorySearch(Route.useSearch())} />;
  },
});
