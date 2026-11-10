import { Button, PageHeader, ScrollRegion, Skeleton } from '@qm/ui';
import { useState } from 'react';
import { useTranslation } from '../../../lib/translation.tsx';
import { useCurrentLocation } from '../../auth/current.ts';
import { widgetPreviewUrl, widgetSnippet } from './snippet.ts';

/**
 * `/admin/widget` (J7, #245): the one-line snippet that puts the join form on the business's own
 * website, with a live preview of what visitors will see.
 */
export function WidgetPage() {
  const { t } = useTranslation('admin');
  const { location } = useCurrentLocation();
  const [copied, setCopied] = useState(false);
  if (!location) return <Skeleton label={t('widget.loading')} rows={2} />;
  const snippet = widgetSnippet(location.slug);

  async function copy() {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
    } catch {
      // Clipboard access can be refused; the snippet stays selectable on screen.
      setCopied(false);
    }
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 pb-8">
      <PageHeader title={t('widget.title')} description={t('widget.hint')} />
      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">{t('widget.snippet')}</h2>
        <ScrollRegion label={t('widget.snippet')}>
          <pre
            data-testid="widget-snippet"
            className="rounded-control border border-border bg-surface p-3 text-sm select-all"
          >
            <code>{snippet}</code>
          </pre>
        </ScrollRegion>
        <div className="flex items-center gap-3">
          <Button onClick={() => void copy()}>{t('widget.copy')}</Button>
          {copied ? <span role="status">{t('widget.copied')}</span> : null}
        </div>
      </section>
      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">{t('widget.preview')}</h2>
        <iframe
          title={t('widget.previewTitle')}
          src={widgetPreviewUrl(location.slug)}
          className="h-[520px] w-full max-w-md rounded-control border border-border"
        />
      </section>
    </div>
  );
}
