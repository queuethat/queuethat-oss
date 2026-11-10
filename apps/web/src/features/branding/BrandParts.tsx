import { useEffect } from 'react';
import { PRODUCT_NAME, SOURCE_CODE_URL, accessibleTextColor } from '@qm/domain';
import { useTranslation } from '../../lib/translation.tsx';
import { useBranding, type Branding } from './api.ts';

/**
 * Sets the brand colour as the primary colour for the whole page (with the readable text colour)
 * while mounted. Custom properties on the root, so the page itself needs no wrapper element.
 */
function useBrandTheme(branding: Branding | undefined) {
  const primary = branding?.primary ?? null;
  const accent = branding?.accent ?? null;
  useEffect(() => {
    const root = document.documentElement.style;
    const set = (name: string, value: string | null) =>
      value ? root.setProperty(name, value) : root.removeProperty(name);
    set('--color-primary', primary);
    set('--color-primary-hover', primary);
    set('--color-on-primary', primary ? accessibleTextColor(primary) : null);
    set('--brand-accent', accent);
    return () => {
      for (const name of [
        '--color-primary',
        '--color-primary-hover',
        '--color-on-primary',
        '--brand-accent',
      ])
        root.removeProperty(name);
    };
  }, [primary, accent]);
}

/** With the product name hidden, the tab shows the business instead (4-WL1). */
function useHiddenProductTitle(branding: Branding | undefined) {
  const title = branding?.hideProductBranding && branding.orgName ? branding.orgName : null;
  useEffect(() => {
    if (!title) return;
    const previous = document.title;
    document.title = title;
    return () => {
      document.title = previous;
    };
  }, [title]);
}

/** The business's logo, name and welcome text, and its theme. Plain text only. */
export function BrandHeader({ slug }: { slug: string | null }) {
  const branding = useBranding(slug).data;
  useBrandTheme(branding);
  useHiddenProductTitle(branding);
  if (!branding) return null;
  const { primary } = branding;
  if (!branding.logoUrl && !branding.welcomeText) return null;
  return (
    <header
      data-testid="branded"
      className="mb-4 flex flex-col gap-2 rounded-control p-4"
      style={
        primary
          ? { backgroundColor: primary, color: accessibleTextColor(primary) }
          : { border: '1px solid currentColor' }
      }
    >
      <div className="flex items-center gap-3">
        {branding.logoUrl ? (
          <img
            src={branding.logoUrl}
            alt=""
            width={40}
            height={40}
            loading="lazy"
            decoding="async"
            className="size-10 shrink-0 rounded object-contain"
          />
        ) : null}
        <strong className="text-lg">{branding.orgName}</strong>
      </div>
      {branding.welcomeText ? <p className="whitespace-pre-line">{branding.welcomeText}</p> : null}
    </header>
  );
}

/**
 * "Powered by" and the source offer (AGPL-3.0 s13). `showName` false hides the product name; the
 * source link is always there. A guest page waits for the branding answer before naming the
 * product, so a hidden name never flashes.
 */
export function ProductLine({ showName }: { showName: boolean }) {
  const { t } = useTranslation('guest');
  return (
    <p className="flex flex-wrap items-center gap-x-2 text-sm" data-testid="product-line">
      {showName ? <span>{t('branding.poweredBy', { name: PRODUCT_NAME })}</span> : null}
      <a
        href={SOURCE_CODE_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex min-h-12 items-center underline"
      >
        {t('branding.source')}
      </a>
    </p>
  );
}

/** Links to the business's terms and privacy policy, opened in a new tab, then the product line. */
export function BrandFooter({ slug }: { slug: string | null }) {
  const { t } = useTranslation('guest');
  const branding = useBranding(slug).data;
  return (
    <footer className="mt-6 flex flex-col gap-2">
      {branding && (branding.termsUrl || branding.privacyUrl) ? (
        <div className="flex flex-wrap gap-4 text-sm">
          {branding.termsUrl ? (
            <a
              href={branding.termsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-h-12 items-center underline"
            >
              {t('branding.terms')}
            </a>
          ) : null}
          {branding.privacyUrl ? (
            <a
              href={branding.privacyUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-h-12 items-center underline"
            >
              {t('branding.privacy')}
            </a>
          ) : null}
        </div>
      ) : null}
      <ProductLine showName={!!branding && !branding.hideProductBranding} />
    </footer>
  );
}
