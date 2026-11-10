import { errorCode } from '@qm/domain';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../../../lib/supabase.ts';

/** Scopes a key can hold, in the order the create dialog lists them (mirrors the table check). */
export const API_SCOPES = [
  'queues:read',
  'queues:write',
  'visits:read',
  'visits:write',
  'analytics:read',
  'webhooks:manage',
] as const;
export type ApiScope = (typeof API_SCOPES)[number];

/** Only owners and admins manage keys; RLS shows the list to nobody else. */
export const canManageApiKeys = (role: string | undefined) => role === 'admin' || role === 'owner';

/** The locale key for a scope: i18next reads a colon as a namespace separator. */
export const scopeKey = (scope: ApiScope) => scope.replace(':', '_') as ScopeKey;
type ScopeKey =
  | 'queues_read'
  | 'queues_write'
  | 'visits_read'
  | 'visits_write'
  | 'analytics_read'
  | 'webhooks_manage';

const keysKey = (orgId: string) => ['admin', 'api-keys', orgId];

/** The org's keys, newest first. The secret hash is not readable; only the prefix is. */
export const apiKeysQuery = (orgId: string) =>
  queryOptions({
    queryKey: keysKey(orgId),
    queryFn: async () => {
      const { data, error } = await supabase
        .schema('app')
        .from('api_keys')
        .select(
          'id, name, prefix, scopes, location_ids, created_at, last_used_at, expires_at, revoked_at',
        )
        .eq('org_id', orgId)
        .order('created_at', { ascending: false });
      if (error) throw new Error(errorCode(error));
      return data;
    },
  });

export interface CreateKeyInput {
  name: string;
  scopes: ApiScope[];
  /** null covers every location. */
  locationIds: string[] | null;
  expiresAt: string | null;
}

/**
 * `api.create_api_key`. Resolves with the plaintext key, which exists only in this result: the
 * server keeps a hash. Errors: `invalid_input`, `invalid_scope`, `permission_denied`, `not_found`.
 */
export function useCreateApiKey(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateKeyInput) => {
      const { data, error } = await supabase.rpc('create_api_key', {
        p_org_id: orgId,
        p_name: input.name.trim(),
        p_scopes: input.scopes,
        p_location_ids: input.locationIds as string[],
        p_expires_at: input.expiresAt as string,
        p_idempotency_key: crypto.randomUUID(),
      });
      if (error) throw new Error(errorCode(error));
      return data as { key_id: string; prefix: string; plaintext_key: string };
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keysKey(orgId) }),
  });
}

/** `api.revoke_api_key`: the key stops working at once. Revoking twice is a no-op. */
export function useRevokeApiKey(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (keyId: string) => {
      const { error } = await supabase.rpc('revoke_api_key', { p_key_id: keyId });
      if (error) throw new Error(errorCode(error));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: keysKey(orgId) }),
  });
}
