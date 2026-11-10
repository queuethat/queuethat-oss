import { errorCode } from '@qm/domain';
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../../lib/supabase.ts';
import { useCurrentOrg } from '../../auth/current.ts';

export interface GuestTag {
  id: string;
  name: string;
}

const tagsKey = ['crm', 'tags'] as const;

/** A table error as a code the screens switch on; RLS refusals (42501) become `forbidden`. */
function failure(error: { code?: string; message: string }) {
  return new Error(error.code === '42501' ? 'forbidden' : errorCode(error));
}

/** Every tag the org has defined, for the picker's suggestions. */
export const orgTagsQuery = () =>
  queryOptions({
    queryKey: [...tagsKey, 'org'],
    queryFn: async (): Promise<GuestTag[]> => {
      const { data, error } = await supabase
        .schema('app')
        .from('guest_tags')
        .select('id, name')
        .order('name');
      if (error) throw failure(error);
      return data;
    },
  });

/** The tags on one guest. */
export const guestTagsQuery = (guestId: string) =>
  queryOptions({
    queryKey: [...tagsKey, 'guest', guestId],
    queryFn: async (): Promise<GuestTag[]> => {
      const { data, error } = await supabase
        .schema('app')
        .from('guest_tag_links')
        .select('guest_tags(id, name)')
        .eq('guest_id', guestId);
      if (error) throw failure(error);
      return data
        .flatMap((row) => (row.guest_tags ? [row.guest_tags] : []))
        .sort((a, b) => a.name.localeCompare(b.name));
    },
  });

/**
 * Tag names by guest id for the guests on screen, one batched read. A failure just means no
 * chips: the console works without them.
 */
export function useGuestTagMap(guestIds: string[]) {
  const ids = [...new Set(guestIds)].sort().slice(0, 200);
  return useQuery({
    queryKey: [...tagsKey, 'map', ids],
    enabled: ids.length > 0,
    queryFn: async (): Promise<Map<string, string[]>> => {
      const { data, error } = await supabase
        .schema('app')
        .from('guest_tag_links')
        .select('guest_id, guest_tags(name)')
        .in('guest_id', ids);
      if (error) throw failure(error);
      const map = new Map<string, string[]>();
      for (const row of data) {
        if (!row.guest_tags) continue;
        map.set(row.guest_id, [...(map.get(row.guest_id) ?? []), row.guest_tags.name].sort());
      }
      return map;
    },
  });
}

/**
 * Puts a tag on a guest, creating the tag when the org has none by that name (manager or above;
 * others get `forbidden`). Tagging twice is a no-op.
 */
export function useAddGuestTag(guestId: string) {
  const queryClient = useQueryClient();
  const org = useCurrentOrg();
  return useMutation({
    mutationFn: async (name: string) => {
      if (!org) throw new Error('forbidden');
      const wanted = name.trim();
      const { data: existing, error: readError } = await supabase
        .schema('app')
        .from('guest_tags')
        .select('id')
        .ilike('name', wanted.replace(/[\\%_]/g, '\\$&'))
        .maybeSingle();
      if (readError) throw failure(readError);
      let tagId = existing?.id;
      if (!tagId) {
        const { data, error } = await supabase
          .schema('app')
          .from('guest_tags')
          .insert({ org_id: org.id, name: wanted })
          .select('id')
          .single();
        if (error) throw failure(error);
        tagId = data.id;
      }
      const { error } = await supabase
        .schema('app')
        .from('guest_tag_links')
        .upsert(
          { org_id: org.id, guest_id: guestId, tag_id: tagId },
          { onConflict: 'guest_id,tag_id', ignoreDuplicates: true },
        );
      if (error) throw failure(error);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: tagsKey }),
  });
}

/** Takes a tag off a guest; the tag itself stays defined. */
export function useRemoveGuestTag(guestId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (tagId: string) => {
      const { error } = await supabase
        .schema('app')
        .from('guest_tag_links')
        .delete()
        .eq('guest_id', guestId)
        .eq('tag_id', tagId);
      if (error) throw failure(error);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: tagsKey }),
  });
}
