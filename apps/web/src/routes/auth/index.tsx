import { createFileRoute, redirect } from '@tanstack/react-router';

// `/auth` has no screen of its own: send it to sign-in (keeping a `?next=` the caller passed).
export const Route = createFileRoute('/auth/')({
  validateSearch: (search): { next?: string } =>
    typeof search.next === 'string' ? { next: search.next } : {},
  beforeLoad: ({ search }) => {
    throw redirect({ to: '/auth/sign-in', search, replace: true });
  },
});
