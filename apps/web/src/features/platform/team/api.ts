import { errorCode } from '@qm/domain';
import { queryOptions } from '@tanstack/react-query';
import { supabase } from '../../../lib/supabase.ts';

// #1134: the platform team list. Read-only: no query or mutation here grants or removes a role
// (that is `pnpm platform:grant` / `pnpm platform:revoke`, technical-design.md 3.6).

/**
 * Everyone holding a platform role (`api.platform_team`), operators first. Operator + aal2 only;
 * support gets permission_denied.
 */
export const platformTeamQuery = queryOptions({
  queryKey: ['platform', 'team'],
  queryFn: async () => {
    const { data, error } = await supabase.rpc('platform_team');
    if (error) throw new Error(errorCode(error));
    return data;
  },
});

export type TeamMember = Awaited<
  ReturnType<NonNullable<(typeof platformTeamQuery)['queryFn']>>
>[number];
