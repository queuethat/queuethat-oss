import { Navigate, createFileRoute } from '@tanstack/react-router';
import { legalUrls } from '../features/marketing/company.ts';
import { ExternalRedirect } from '../features/marketing/ExternalRedirect.tsx';
import { loadNamespaces } from '../lib/i18n.ts';

// Linked from Twilio, Stripe and the sign-up form: keep this URL stable. The text lives on the
// operator's own site; an install that has not published one sends the visitor home.
function Page() {
  const to = legalUrls().privacy;
  return to ? <ExternalRedirect to={to} /> : <Navigate to="/" replace />;
}

export const Route = createFileRoute('/privacy')({
  beforeLoad: () => loadNamespaces('marketing'),
  component: Page,
});
