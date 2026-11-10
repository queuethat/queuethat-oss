import { createFileRoute } from '@tanstack/react-router';
import { Branded } from '../../features/branding/Branded.tsx';
import { BookingPage } from '../../features/booking/BookingPage.tsx';

export const Route = createFileRoute('/b/$locationSlug')({
  validateSearch: (search: Record<string, unknown>): { service?: string } =>
    typeof search.service === 'string' ? { service: search.service } : {},
  component: function Book() {
    const { locationSlug } = Route.useParams();
    const { service } = Route.useSearch();
    return (
      <Branded slug={locationSlug}>
        <BookingPage slug={locationSlug} initialService={service} />
      </Branded>
    );
  },
});
