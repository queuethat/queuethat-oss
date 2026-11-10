import { createFileRoute, redirect } from '@tanstack/react-router';

// The per-queue question editor is retired: a queue's questions now live in its form
// (/admin/forms). The old URL keeps working for bookmarks.
export const Route = createFileRoute('/admin/queues/$queueId_/intake')({
  beforeLoad: () => {
    throw redirect({ to: '/admin/forms', replace: true });
  },
});
