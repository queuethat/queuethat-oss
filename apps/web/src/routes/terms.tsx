import { createFileRoute } from '@tanstack/react-router';
import { LEGAL_URLS } from '../features/marketing/company.ts';
import { ExternalRedirect } from '../features/marketing/ExternalRedirect.tsx';
import { loadNamespaces } from '../lib/i18n.ts';

// Linked from Twilio, Stripe and the sign-up form: keep this URL stable. The text lives on queuethat.com.
export const Route = createFileRoute('/terms')({
  beforeLoad: () => loadNamespaces('marketing'),
  component: () => <ExternalRedirect to={LEGAL_URLS.terms} />,
});
