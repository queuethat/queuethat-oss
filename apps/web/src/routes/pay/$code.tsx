import { createFileRoute } from '@tanstack/react-router';
import { PayCodePage } from '../../features/guest/PayCodePage.tsx';

export const Route = createFileRoute('/pay/$code')({
  component: function Pay() {
    const { code } = Route.useParams();
    return <PayCodePage code={code} />;
  },
});
