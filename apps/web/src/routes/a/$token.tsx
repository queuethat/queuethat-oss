import { createFileRoute } from '@tanstack/react-router';
import { AppointmentPage } from '../../features/appointment/AppointmentPage.tsx';
import { Branded } from '../../features/branding/Branded.tsx';
import { useAppointment } from '../../features/booking/api.ts';

export const Route = createFileRoute('/a/$token')({
  component: function Appointment() {
    const { token } = Route.useParams();
    // The same query AppointmentPage runs, so this adds no request: the booking carries the slug.
    const slug = useAppointment(token).data?.location_slug ?? null;
    return (
      <Branded slug={slug}>
        <AppointmentPage token={token} />
      </Branded>
    );
  },
});
