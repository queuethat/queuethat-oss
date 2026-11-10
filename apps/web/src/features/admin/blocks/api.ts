import { errorCode } from '@qm/domain';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../../lib/supabase.ts';

export interface Block {
  id: string;
  kind: 'phone_hash' | 'email_hash' | 'device_key';
  reason: string;
  /** auth user id of who blocked; looked up against the team for a name. */
  createdBy: string | null;
  createdAt: string;
  expiresAt: string | null;
}

const blocksKey = (orgId: string) => ['admin', 'blocks', orgId] as const;

/**
 * The org's blocks, newest first. Staff may read them (RLS); the table holds only hashes, so a
 * row says what kind of thing is blocked and why, never the phone or email itself.
 */
export const blocksQuery = (orgId: string) =>
  queryOptions({
    queryKey: blocksKey(orgId),
    queryFn: async (): Promise<Block[]> => {
      const { data, error } = await supabase
        .schema('app')
        .from('blocked_identities')
        .select('id, kind, reason, created_by, created_at, expires_at')
        .eq('org_id', orgId)
        .order('created_at', { ascending: false });
      if (error) throw new Error(errorCode(error));
      return data.map((b) => ({
        id: b.id,
        kind: b.kind as Block['kind'],
        reason: b.reason,
        createdBy: b.created_by,
        createdAt: b.created_at,
        expiresAt: b.expires_at,
      }));
    },
  });

/** `api.unblock`: managers and above; the phone or device can join again at once. */
export function useUnblock(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (blockId: string) => {
      const { error } = await supabase.rpc('unblock', { p_block_id: blockId });
      if (error) throw new Error(errorCode(error));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: blocksKey(orgId) }),
  });
}
