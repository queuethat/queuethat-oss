import { Button, Card, PageHeader, Skeleton } from '@qm/ui';
import { useState } from 'react';
import { useTranslation } from '../../../../lib/translation.tsx';
import { useCurrentLocation } from '../../../auth/current.ts';
import { gbpLink } from './link.ts';

/**
 * `/admin/google` (J-7, #246): the join link to paste into a Google Business Profile, with the
 * steps. Google's own waitlist integration needs partner approval, so this is the free route;
 * guests who arrive through the link are attributed to it (`?src=gbp`).
 */
export function GbpPage() {
  const { t } = useTranslation('admin');
  const { location } = useCurrentLocation();
  const [copied, setCopied] = useState(false);
  if (!location) return <Skeleton label={t('gbp.loading')} rows={2} />;
  const link = gbpLink(location.slug);

  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      // Clipboard access can be refused; the link stays selectable on screen.
      setCopied(false);
    }
  }

  return (
    <div className="flex flex-col gap-6 pb-8">
      <PageHeader title={t('gbp.title')} description={t('gbp.hint')} />
      <Card className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">{t('gbp.link')}</h2>
        <p data-testid="gbp-link" className="font-mono break-all select-all">
          {link}
        </p>
        <div className="flex items-center gap-3">
          <Button onClick={() => void copy()}>{t('gbp.copy')}</Button>
          {copied ? <span role="status">{t('gbp.copied')}</span> : null}
        </div>
      </Card>
      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">{t('gbp.stepsTitle')}</h2>
        <ol className="flex list-decimal flex-col gap-1 pl-6">
          <li>{t('gbp.step1')}</li>
          <li>{t('gbp.step2')}</li>
          <li>{t('gbp.step3')}</li>
          <li>{t('gbp.step4')}</li>
        </ol>
      </section>
      <p className="rounded-control border border-border p-3">{t('gbp.limits')}</p>
    </div>
  );
}
