import { Button, PageHeader, Skeleton } from '@qm/ui';
import { useTranslation } from '../../../lib/translation.tsx';
import { useCurrentLocation, useCurrentOrg } from '../../auth/current.ts';
import { useVerifiedDomain } from '../domains/api.ts';
import { useTelegramLink, useTextToJoin } from './api.ts';
import { JoinQr } from './JoinQr.tsx';
import { publicJoinUrl } from './url.ts';

/**
 * `/admin/poster` (G7, #57): an A4 or Letter poster for the current location with a QR code of
 * its join page. The code is drawn here, so no outside service sees the address.
 */
export function PosterPage() {
  const { t } = useTranslation('admin');
  const { location } = useCurrentLocation();
  const org = useCurrentOrg();
  // A verified custom domain replaces the main address; a pending one never does.
  const customHost = useVerifiedDomain(org?.id, location?.id);
  const textToJoin = useTextToJoin(org?.id, location?.id).data;
  const telegram = useTelegramLink(location?.slug, location?.id);
  if (!location) return <Skeleton label={t('poster.loading')} rows={2} />;
  const url = publicJoinUrl(location.slug, customHost ? `https://${customHost}` : undefined);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 pb-8 print:m-0 print:max-w-none print:p-0">
      <PageHeader
        className="print:hidden"
        title={t('poster.title')}
        description={t('poster.hint')}
        actions={<Button onClick={() => window.print()}>{t('poster.print')}</Button>}
      />
      {/* Paper is white whatever the screen theme, so the preview matches the print. */}
      <article
        data-testid="poster"
        className="flex flex-col items-center gap-6 rounded-control border border-border bg-white p-10 text-center text-black print:h-[249mm] print:justify-center print:border-0 print:p-0"
      >
        <p className="text-3xl font-semibold">{location.name}</p>
        <h2 className="text-5xl font-bold">{t('poster.headline')}</h2>
        <JoinQr
          url={url}
          label={t('poster.code', { url })}
          className="w-72 max-w-full print:w-[110mm]"
        />
        <ol className="flex flex-col gap-1 text-xl">
          <li>{t('poster.step1')}</li>
          <li>{t('poster.step2')}</li>
          <li>{t('poster.step3')}</li>
        </ol>
        {textToJoin ? (
          <p className="text-2xl font-semibold" data-testid="poster-text-to-join">
            {t('poster.textToJoin', {
              keyword: textToJoin.keyword.toUpperCase(),
              number: textToJoin.number,
            })}
          </p>
        ) : null}
        {telegram ? (
          <p className="text-xl" data-testid="poster-telegram">
            {t('poster.telegram')} <span className="font-mono break-all">{telegram}</span>
          </p>
        ) : null}
        <p className="text-lg">
          {t('poster.orVisit')} <span className="font-mono break-all">{url}</span>
        </p>
      </article>
    </div>
  );
}
