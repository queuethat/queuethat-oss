import { useQuery } from '@tanstack/react-query';
import { appConfig } from '../../lib/config.ts';
import { guestRpc } from '../guest/client.ts';
import { isHexColor } from '@qm/domain';

/** A location's public branding, with image paths made absolute and colours validated. */
export interface Branding {
  orgName: string;
  logoUrl: string | null;
  coverUrl: string | null;
  primary: string | null;
  accent: string | null;
  welcomeText: string | null;
  termsUrl: string | null;
  privacyUrl: string | null;
  /** True: leave the product name out. The source link is never optional. */
  hideProductBranding: boolean;
}

const httpsOnly = (url: string | null) => (url && /^https:\/\/\S+$/.test(url) ? url : null);

/**
 * `api.get_location_branding` once per slug. Guests only: plain fetch, no supabase-js. The
 * database already checks colours and links; they are checked again here because they end up in
 * CSS and in hrefs. A failure (unknown slug, offline) leaves the default theme.
 */
export function useBranding(slug: string | null) {
  return useQuery({
    enabled: !!slug,
    queryKey: ['guest', 'branding', slug],
    staleTime: 10 * 60_000,
    retry: false,
    queryFn: async (): Promise<Branding> => {
      const row = await guestRpc('get_location_branding', { p_slug: slug });
      const origin = appConfig().supabaseUrl;
      return {
        orgName: row.org_name ?? '',
        logoUrl: storagePath(row.logo_url) ? origin + row.logo_url : null,
        coverUrl: storagePath(row.cover_url) ? origin + row.cover_url : null,
        primary: row.brand_primary && isHexColor(row.brand_primary) ? row.brand_primary : null,
        accent: row.brand_accent && isHexColor(row.brand_accent) ? row.brand_accent : null,
        welcomeText: row.welcome_text,
        termsUrl: httpsOnly(row.terms_url),
        privacyUrl: httpsOnly(row.privacy_url),
        hideProductBranding: row.hide_product_branding === true,
      };
    },
  });
}

function storagePath(p: string | null | undefined): p is string {
  return !!p && p.startsWith('/storage/');
}
