import { Button, Dialog } from '@qm/ui';
import { useState } from 'react';
import { useTranslation } from '../../lib/translation.tsx';
import { JoinQr } from '../admin/poster/JoinQr.tsx';
import { publicJoinUrl } from '../admin/poster/url.ts';
import { useCurrentLocation } from '../auth/current.ts';

/** The two ways to get the first guest into an empty console: copy the join link, or show its QR. */
export function ShareLine() {
  const { t } = useTranslation('empty');
  const { location } = useCurrentLocation();
  const [copied, setCopied] = useState(false);
  const [showQr, setShowQr] = useState(false);
  if (!location) return null;
  const url = publicJoinUrl(location.slug);
  const copy = async () => {
    // The clipboard needs a secure context; the QR works either way.
    await navigator.clipboard?.writeText(url).then(
      () => setCopied(true),
      () => {},
    );
  };
  return (
    <>
      <Button onClick={() => void copy()}>{t('console.copy')}</Button>
      <Button variant="secondary" onClick={() => setShowQr(true)}>
        {t('console.qr')}
      </Button>
      <p role="status" className="w-full text-sm text-muted empty:hidden">
        {copied ? t('console.copied') : null}
      </p>
      <Dialog open={showQr} onClose={() => setShowQr(false)} title={t('console.qrTitle')}>
        <div className="flex flex-col items-center gap-4">
          <JoinQr
            url={url}
            label={t('console.qrLabel', { url })}
            className="w-64 max-w-full rounded-card border border-border"
          />
          <p className="break-all font-mono text-sm">{url}</p>
          <Button variant="secondary" onClick={() => setShowQr(false)}>
            {t('console.close')}
          </Button>
        </div>
      </Dialog>
    </>
  );
}
