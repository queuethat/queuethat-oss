import { Navigate, createFileRoute } from '@tanstack/react-router';
import { legalUrls } from '../features/marketing/company.ts';
import { ExternalRedirect } from '../features/marketing/ExternalRedirect.tsx';
import { loadNamespaces } from '../lib/i18n.ts';

// A stable address for the operator's own page (carrier and payment registrations link to it).
// An install that has not published one sends the visitor home.
function Page() {
  const to = legalUrls().privacy;
  return to ? <ExternalRedirect to={to} /> : <Navigate to="/" replace />;
}

export const Route = createFileRoute('/privacy')({
  beforeLoad: () => loadNamespaces('marketing'),
  component: Page,
});
