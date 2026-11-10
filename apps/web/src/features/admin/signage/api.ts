import { errorCode } from '@qm/domain';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../../lib/supabase.ts';
import type { EncodedImage } from '../branding/image.ts';

const BUCKET = 'signage';

/** One slide as the admin page edits it. Image slides carry a path, text slides a body. */
export interface Slide {
  id: string;
  kind: 'image' | 'text';
  storagePath: string | null;
  body: string | null;
  durationS: number;
  activeFrom: string | null;
  activeTo: string | null;
  sort: number;
}

/** What the admin sets on a new or edited slide. */
export interface SlideDraft {
  durationS: number;
  activeFrom: string | null;
  activeTo: string | null;
  body?: string;
}

/** Public URL of a signage image, for previews. */
export function signageUrl(path: string): string {
  return supabase.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
}

/** The location's slides in display order, read under RLS (staff and devices read; admins write). */
export const slidesQuery = (locationId: string) =>
  queryOptions({
    queryKey: ['admin', 'signage', locationId],
    queryFn: async (): Promise<Slide[]> => {
      const { data, error } = await supabase
        .schema('app')
        .from('signage_slides')
        .select('id, kind, storage_path, body, duration_s, active_from, active_to, sort')
        .eq('location_id', locationId)
        .order('sort')
        .order('created_at');
      if (error) throw error;
      return data.map((r) => ({
        id: r.id,
        kind: r.kind,
        storagePath: r.storage_path,
        body: r.body,
        durationS: r.duration_s,
        activeFrom: r.active_from,
        activeTo: r.active_to,
        sort: r.sort,
      }));
    },
  });

/**
 * Adds a text slide, or an image slide when `image` is given (uploaded to
 * `org/{org}/signage/{time}.{ext}` first, admins only by storage policy) at the end of the list.
 * Rejects with Error(<error code>).
 */
export function useAddSlide(orgId: string, locationId: string, nextSort: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ draft, image }: { draft: SlideDraft; image: EncodedImage | null }) => {
      let path: string | null = null;
      if (image) {
        path = `org/${orgId}/signage/${Date.now()}.${image.extension}`;
        const up = await supabase.storage
          .from(BUCKET)
          .upload(path, image.blob, { contentType: image.blob.type, upsert: false });
        if (up.error) throw new Error('permission_denied');
      }
      const { error } = await supabase
        .schema('app')
        .from('signage_slides')
        .insert({
          org_id: orgId,
          location_id: locationId,
          kind: image ? 'image' : 'text',
          storage_path: path,
          body: image ? null : (draft.body ?? '').trim(),
          duration_s: draft.durationS,
          active_from: draft.activeFrom,
          active_to: draft.activeTo,
          sort: nextSort,
        });
      if (error) {
        if (path) await supabase.storage.from(BUCKET).remove([path]);
        throw new Error(errorCode(error));
      }
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin', 'signage'] }),
  });
}

/** Changes a slide's duration or schedule window. */
export function useUpdateSlide() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, draft }: { id: string; draft: SlideDraft }) => {
      const { error } = await supabase
        .schema('app')
        .from('signage_slides')
        .update({
          duration_s: draft.durationS,
          active_from: draft.activeFrom,
          active_to: draft.activeTo,
        })
        .eq('id', id);
      if (error) throw new Error(errorCode(error));
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin', 'signage'] }),
  });
}

/** Gives the slides the order of `ids` (sort 10, 20, ...). */
export function useReorderSlides() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (ids: string[]) => {
      const results = await Promise.all(
        ids.map((id, i) =>
          supabase
            .schema('app')
            .from('signage_slides')
            .update({ sort: (i + 1) * 10 })
            .eq('id', id),
        ),
      );
      const failed = results.find((r) => r.error);
      if (failed?.error) throw new Error(errorCode(failed.error));
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin', 'signage'] }),
  });
}

/** Deletes a slide and its image. */
export function useDeleteSlide() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (slide: Slide) => {
      const { error } = await supabase
        .schema('app')
        .from('signage_slides')
        .delete()
        .eq('id', slide.id);
      if (error) throw new Error(errorCode(error));
      if (slide.storagePath) await supabase.storage.from(BUCKET).remove([slide.storagePath]);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin', 'signage'] }),
  });
}
