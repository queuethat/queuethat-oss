import { useEffect } from 'react';
import { useTranslation } from '../../lib/translation.tsx';

/**
 * Sends the browser to another site. Vercel already redirects /terms and /privacy at the edge
 * (vercel.json); this covers every other host, such as Docker or local dev.
 */
export function ExternalRedirect({ to }: { to: string }) {
  const { t } = useTranslation('marketing');
  useEffect(() => {
    window.location.replace(to);
  }, [to]);
  return (
    <p className="p-5">
      <a href={to} className="inline-flex min-h-target items-center underline">
        {t('redirect.continue')}
      </a>
    </p>
  );
}
