import type { QueryClient } from '@tanstack/react-query';
import {
  createRootRouteWithContext,
  Link,
  Outlet,
  redirect,
  type ErrorComponentProps,
} from '@tanstack/react-router';
import { DemoBanner } from '../features/demo/DemoBanner.tsx';
import { OfflineBanner } from '../features/pwa/OfflineBanner.tsx';
import { UpdatePrompt } from '../features/pwa/UpdatePrompt.tsx';
import { useTranslation } from '../lib/translation.tsx';
import { hostDecision } from '../lib/host.ts';
import '../styles.css';

export interface RouterContext {
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  // 3-DOM2 (#371): on a business's own domain, `/` is its join page and staff routes move to the main host.
  beforeLoad: async ({ location }) => {
    const decision = await hostDecision(location.pathname, location.searchStr);
    if (decision.kind === 'redirect') {
      window.location.replace(decision.href);
      await new Promise(() => undefined); // the browser is leaving; render nothing meanwhile
    }
    if (decision.kind === 'location') {
      throw redirect({
        to: '/q/$locationSlug',
        params: { locationSlug: decision.slug },
        replace: true,
      });
    }
  },
  component: RootLayout,
  notFoundComponent: NotFound,
  errorComponent: RootError,
});

function RootLayout() {
  return (
    <>
      <div className="sticky top-0 z-10">
        <DemoBanner />
        <OfflineBanner />
        <UpdatePrompt />
      </div>
      <Outlet />
    </>
  );
}

function NotFound() {
  const { t } = useTranslation();
  return (
    <main className="page-message" data-testid="not-found">
      <h1>{t('notFound.title')}</h1>
      <Link to="/" className="inline-flex min-h-target items-center underline">
        {t('notFound.home')}
      </Link>
    </main>
  );
}

function RootError({ error, reset }: ErrorComponentProps) {
  const { t } = useTranslation();
  return (
    <main className="page-message" role="alert" data-testid="root-error">
      <h1>{t('error.title')}</h1>
      {error instanceof Error ? <p>{error.message}</p> : null}
      <button type="button" onClick={reset}>
        {t('error.retry')}
      </button>
    </main>
  );
}
