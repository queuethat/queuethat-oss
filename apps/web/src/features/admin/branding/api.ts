import { errorCode } from '@qm/domain';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../../lib/supabase.ts';
import type { EncodedImage } from './image.ts';

const BUCKET = 'branding';

/** What an admin edits on the branding page: the org's look and one location's guest page text. */
export interface BrandingSettings {
  logoPath: string | null;
  brandPrimary: string;
  brandAccent: string;
  coverPath: string | null;
  welcomeText: string;
  termsUrl: string;
  privacyUrl: string;
  hideProductBranding: boolean;
}

/** Public URL of a branding object, for previews. */
export function brandingUrl(path: string): string {
  return supabase.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
}

/** Org colours and logo plus the location's cover, welcome text and legal links, read under RLS. */
export const brandingQuery = (orgId: string, locationId: string) =>
  queryOptions({
    queryKey: ['admin', 'branding', orgId, locationId],
    queryFn: async (): Promise<BrandingSettings> => {
      const [org, loc] = await Promise.all([
        supabase
          .schema('app')
          .from('organizations')
          .select('logo_path, brand_primary, brand_accent, hide_product_branding')
          .eq('id', orgId)
          .single(),
        supabase
          .schema('app')
          .from('locations')
          .select('cover_path, welcome_text, terms_url, privacy_url')
          .eq('id', locationId)
          .single(),
      ]);
      if (org.error) throw org.error;
      if (loc.error) throw loc.error;
      return {
        logoPath: org.data.logo_path,
        brandPrimary: org.data.brand_primary ?? '',
        brandAccent: org.data.brand_accent ?? '',
        coverPath: loc.data.cover_path,
        welcomeText: loc.data.welcome_text ?? '',
        termsUrl: loc.data.terms_url ?? '',
        privacyUrl: loc.data.privacy_url ?? '',
        hideProductBranding: org.data.hide_product_branding,
      };
    },
  });

/**
 * Uploads a re-encoded image to `org/{org}/branding/{kind}-{time}.{ext}` (admins only, by
 * storage policy), points the org logo or the location cover at it and removes the old file.
 * Passing `image: null` clears it. Rejects with Error(<error code>).
 */
export function useSetBrandImage(orgId: string, locationId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      kind,
      image,
      previous,
    }: {
      kind: 'logo' | 'cover';
      image: EncodedImage | null;
      previous: string | null;
    }) => {
      let path: string | null = null;
      if (image) {
        path = `org/${orgId}/branding/${kind}-${Date.now()}.${image.extension}`;
        const { error } = await supabase.storage
          .from(BUCKET)
          .upload(path, image.blob, { contentType: image.blob.type, upsert: false });
        if (error) throw new Error('permission_denied');
      }
      const result =
        kind === 'logo'
          ? await supabase
              .schema('app')
              .from('organizations')
              .update({ logo_path: path })
              .eq('id', orgId)
              .select('id')
          : await supabase
              .schema('app')
              .from('locations')
              .update({ cover_path: path })
              .eq('id', locationId)
              .select('id');
      if (result.error) throw new Error(errorCode(result.error));
      if (result.data.length === 0) throw new Error('permission_denied');
      if (previous) await supabase.storage.from(BUCKET).remove([previous]);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin', 'branding'] }),
  });
}

/** Saves colours, welcome text and legal links. Empty strings clear a field. */
export function useSaveBranding(orgId: string, locationId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (settings: BrandingSettings) => {
      const org = await supabase
        .schema('app')
        .from('organizations')
        .update({
          brand_primary: settings.brandPrimary || null,
          brand_accent: settings.brandAccent || null,
        })
        .eq('id', orgId)
        .select('id');
      if (org.error) throw new Error(errorCode(org.error));
      if (org.data.length === 0) throw new Error('permission_denied');
      const loc = await supabase
        .schema('app')
        .from('locations')
        .update({
          welcome_text: settings.welcomeText.trim() || null,
          terms_url: settings.termsUrl.trim() || null,
          privacy_url: settings.privacyUrl.trim() || null,
        })
        .eq('id', locationId)
        .select('id');
      if (loc.error) throw new Error(errorCode(loc.error));
      if (loc.data.length === 0) throw new Error('permission_denied');
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin', 'branding'] }),
  });
}

/**
 * Hides or shows the product name on guest pages, displays and email (4-WL1). Owners only: the
 * database refuses anyone else with 42501. The source link stays either way.
 */
export function useSetHideProductBranding(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (hide: boolean) => {
      const result = await supabase
        .schema('app')
        .from('organizations')
        .update({ hide_product_branding: hide })
        .eq('id', orgId)
        .select('id');
      if (result.error) throw new Error(errorCode(result.error));
      if (result.data.length === 0) throw new Error('permission_denied');
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin', 'branding'] }),
  });
}
