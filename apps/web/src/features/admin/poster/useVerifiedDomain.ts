import { errorCode } from '@qm/domain';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '../../../lib/supabase.ts';

/**
 * The verified custom domain of a location, for posters. Null while it is pending, failed or
 * disabled (the poster keeps the main domain), when the org has none, and for staff who cannot
 * read the table. Read only: claiming and verifying a domain is the setup page in `ee/`.
 */
export function useVerifiedDomain(orgId: string | undefined, locationId: string | undefined) {
  const query = useQuery({
    // Same key the setup page in ee/ invalidates, so a change there refreshes the poster.
    queryKey: ['admin', 'domains', orgId ?? ''],
    enabled: !!orgId,
    queryFn: async () => {
      const { data, error } = await supabase
        .schema('app')
        .from('custom_domains')
        .select(
          'id, hostname, default_location_id, verification_token, status, verified_at, last_checked_at',
        )
        .eq('org_id', orgId ?? '')
        .order('created_at');
      if (error) throw new Error(errorCode(error));
      return data;
    },
  });
  return (
    query.data?.find((d) => d.status === 'verified' && d.default_location_id === locationId)
      ?.hostname ?? null
  );
}
