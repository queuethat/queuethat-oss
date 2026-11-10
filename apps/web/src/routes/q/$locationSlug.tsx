import { createFileRoute } from '@tanstack/react-router';
import { Branded } from '../../features/branding/Branded.tsx';
import { JoinPage } from '../../features/guest/JoinPage.tsx';

export const Route = createFileRoute('/q/$locationSlug')({
  component: function Join() {
    const { locationSlug } = Route.useParams();
    return (
      <Branded slug={locationSlug}>
        <JoinPage slug={locationSlug} />
      </Branded>
    );
  },
});
