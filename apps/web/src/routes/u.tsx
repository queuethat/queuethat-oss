import { createFileRoute } from '@tanstack/react-router';
import { UnsubscribePage } from '../features/guest/UnsubscribePage.tsx';
import { GuestLayout } from '../layouts/GuestLayout.tsx';

// `/u?n=&t=` links are sent in every guest email. Never rename or move it.
export const Route = createFileRoute('/u')({
  validateSearch: (search): { n: string; t: string } => ({
    n: typeof search.n === 'string' ? search.n : '',
    t: typeof search.t === 'string' ? search.t : '',
  }),
  component: function Unsubscribe() {
    const { n, t } = Route.useSearch();
    return (
      <GuestLayout>
        <UnsubscribePage n={n} t={t} />
      </GuestLayout>
    );
  },
});
