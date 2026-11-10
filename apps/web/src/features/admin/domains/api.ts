import { errorCode } from '@qm/domain';
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { appConfig } from '../../../lib/config.ts';
import { supabase } from '../../../lib/supabase.ts';

/** Only owners and admins manage domains; RLS shows the list to nobody else. */
export const canManageDomains = (role: string | undefined) => role === 'admin' || role === 'owner';

const domainsKey = (orgId: string) => ['admin', 'domains', orgId];

/** The org's custom domains, oldest first. The verification token is the public DNS TXT value. */
export const domainsQuery = (orgId: string) =>
  queryOptions({
    queryKey: domainsKey(orgId),
    queryFn: async () => {
      const { data, error } = await supabase
        .schema('app')
        .from('custom_domains')
        .select(
          'id, hostname, default_location_id, verification_token, status, verified_at, last_checked_at',
        )
        .eq('org_id', orgId)
        .order('created_at');
      if (error) throw new Error(errorCode(error));
      return data;
    },
  });

/**
 * The verified custom domain of a location, for posters. Null while it is pending, failed or
 * disabled (the poster keeps the main domain), and for staff who cannot read the table.
 */
export function useVerifiedDomain(orgId: string | undefined, locationId: string | undefined) {
  const query = useQuery({ ...domainsQuery(orgId ?? ''), enabled: !!orgId });
  return (
    query.data?.find((d) => d.status === 'verified' && d.default_location_id === locationId)
      ?.hostname ?? null
  );
}

/**
 * `api.add_custom_domain`. The browser converts an IDN to punycode first, as the database only
 * takes ASCII. Errors: `invalid_input`, `domain_taken`, `permission_denied`, `not_found`.
 */
export function useAddDomain(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { hostname: string; locationId: string }) => {
      let hostname = input.hostname.trim();
      try {
        hostname = new URL(`https://${hostname}`).hostname;
      } catch {
        throw new Error('invalid_input');
      }
      const { error } = await supabase.rpc('add_custom_domain', {
        p_org_id: orgId,
        p_hostname: hostname,
        p_location_id: input.locationId,
        p_idempotency_key: crypto.randomUUID(),
      });
      if (error) throw new Error(errorCode(error));
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: domainsKey(orgId) }),
  });
}

/** `api.remove_custom_domain`: the host stops serving at once. */
export function useRemoveDomain(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (domainId: string) => {
      const { error } = await supabase.rpc('remove_custom_domain', {
        p_domain_id: domainId,
        p_idempotency_key: crypto.randomUUID(),
      });
      if (error) throw new Error(errorCode(error));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: domainsKey(orgId) }),
  });
}

/** domain-check POST: looks for the TXT record now. Errors: `unavailable` when DNS could not be asked. */
export function useVerifyDomain(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (domainId: string) => {
      const { data: session } = await supabase.auth.getSession();
      const res = await fetch(`${appConfig().supabaseUrl}/functions/v1/domain-check`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.session?.access_token ?? ''}`,
        },
        body: JSON.stringify({ domain_id: domainId }),
      });
      if (!res.ok) throw new Error(res.status === 502 ? 'unavailable' : 'unknown');
      return ((await res.json()) as { status: string }).status;
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: domainsKey(orgId) }),
  });
}

/** The name a CNAME should point at: the main host guests and staff use. */
export function mainHostname(): string {
  try {
    return new URL(appConfig().publicUrl || window.location.origin).hostname;
  } catch {
    return window.location.hostname;
  }
}
