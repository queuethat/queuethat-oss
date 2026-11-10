import { errorCode } from '@qm/domain';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../../lib/supabase.ts';
import { useCurrentOrg } from '../../auth/current.ts';
import { useSession } from '../../auth/api.ts';

export interface GuestNote {
  id: string;
  body: string;
  createdAt: string;
  authorId: string | null;
}

const notesKey = ['crm', 'notes'] as const;

/** A guest's notes, newest first. Deleted notes are hidden by row-level security. */
export const guestNotesQuery = (guestId: string) =>
  queryOptions({
    queryKey: [...notesKey, guestId],
    queryFn: async (): Promise<GuestNote[]> => {
      const { data, error } = await supabase
        .schema('app')
        .from('guest_notes')
        .select('id, body, created_at, author_user_id')
        .is('deleted_at', null)
        .eq('guest_id', guestId)
        .order('created_at', { ascending: false });
      if (error) throw new Error(errorCode(error));
      return data.map((n) => ({
        id: n.id,
        body: n.body,
        createdAt: n.created_at,
        authorId: n.author_user_id,
      }));
    },
  });

/** Adds a note as the signed-in user. */
export function useAddGuestNote(guestId: string) {
  const queryClient = useQueryClient();
  const org = useCurrentOrg();
  const userId = useSession().data?.user.id;
  return useMutation({
    mutationFn: async (body: string) => {
      if (!org || !userId) throw new Error('forbidden');
      const { error } = await supabase
        .schema('app')
        .from('guest_notes')
        .insert({ org_id: org.id, guest_id: guestId, author_user_id: userId, body: body.trim() });
      if (error) throw new Error(errorCode(error));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: notesKey }),
  });
}

/** Soft-deletes a note (its author, or an admin). */
export function useDeleteGuestNote() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (noteId: string) => {
      const { error } = await supabase
        .schema('app')
        .from('guest_notes')
        .update({ deleted_at: new Date().toISOString() })
        .eq('id', noteId);
      if (error) throw new Error(errorCode(error));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: notesKey }),
  });
}
