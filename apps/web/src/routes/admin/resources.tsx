import { createFileRoute } from '@tanstack/react-router';
import { CountersPage } from '../../features/admin/counters/CountersPage.tsx';

// `/admin/counters` stays for bookmarks; this is the same screen under its new name (2A-Q3).
export const Route = createFileRoute('/admin/resources')({
  component: CountersPage,
});
