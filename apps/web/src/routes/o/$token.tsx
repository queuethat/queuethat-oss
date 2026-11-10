import { createFileRoute } from '@tanstack/react-router';
import { Branded } from '../../features/branding/Branded.tsx';
import { OfferPage } from '../../features/booking/waitlist/OfferPage.tsx';
import { useWaitlistEntry } from '../../features/booking/waitlist/api.ts';

export const Route = createFileRoute('/o/$token')({
  component: function Offer() {
    const { token } = Route.useParams();
    // The same query OfferPage runs, so this adds no request: the entry carries the slug.
    const slug = useWaitlistEntry(token).data?.location_slug ?? null;
    return (
      <Branded slug={slug}>
        <OfferPage token={token} />
      </Branded>
    );
  },
});
