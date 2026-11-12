import { queryOptions } from '@tanstack/react-query';
import { supabase } from '../../../lib/supabase.ts';

export interface MyLines {
  /** The member's assigned lines (`memberships.queue_ids`); null = every line. */
  queueIds: string[] | null;
  /** True when the org limits staff to their lines and this member has some: they see only those. */
  restricted: boolean;
}

/**
 * The signed-in member's own lines in `orgId`, read under RLS (a member always reads their own
 * membership). Decides the console's default line view; the database still enforces the scope.
 */
export const myLinesQuery = (orgId: string) =>
  queryOptions({
    queryKey: ['console', 'my-lines', orgId],
    queryFn: async (): Promise<MyLines> => {
      const { data: session } = await supabase.auth.getSession();
      const [membership, org] = await Promise.all([
        supabase
          .schema('app')
          .from('memberships')
          .select('queue_ids')
          .eq('org_id', orgId)
          .eq('user_id', session.session?.user.id ?? '')
          .maybeSingle(),
        supabase
          .schema('app')
          .from('organizations')
          .select('scope_staff_to_lines')
          .eq('id', orgId)
          .single(),
      ]);
      if (membership.error) throw membership.error;
      if (org.error) throw org.error;
      const queueIds = membership.data?.queue_ids ?? null;
      return { queueIds, restricted: org.data.scope_staff_to_lines && queueIds !== null };
    },
    staleTime: 60_000,
  });
