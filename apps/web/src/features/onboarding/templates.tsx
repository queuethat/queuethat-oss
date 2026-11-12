import { errorCode } from '@qm/domain';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase.ts';

/** What `apply_industry_template` created. */
export interface TemplateResult {
  templateKey: string;
  queuesCreated: number;
  servicesCreated: number;
  countersCreated: number;
}

/** "How many doctors?": one personal line per name, plus the optional "Anyone available" pool (T4). */
export interface ProviderSetup {
  names: string[];
  pool: boolean;
}

/**
 * Applies a template to a location in one transaction; a retry with the same key is a no-op.
 * With `providers`, it makes their personal lines (and pool) instead of the template's queues.
 */
export async function applyTemplate(
  locationId: string,
  templateKey: string,
  idempotencyKey: string,
  providers: ProviderSetup | null = null,
): Promise<TemplateResult> {
  const { data, error } = await supabase.rpc('apply_industry_template', {
    p_location_id: locationId,
    p_template_key: templateKey,
    p_idempotency_key: idempotencyKey,
    ...(providers
      ? { p_providers: providers.names.map((n) => n.trim()), p_pool: providers.pool }
      : {}),
  });
  if (error) throw new Error(errorCode(error));
  return {
    templateKey: data.template_key!,
    queuesCreated: data.queues_created ?? 0,
    servicesCreated: data.services_created ?? 0,
    countersCreated: data.counters_created ?? 0,
  };
}

/** Applies a template from the location settings page and refreshes what it created. */
export function useApplyTemplate(locationId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      templateKey,
      idempotencyKey,
      providers = null,
    }: {
      templateKey: string;
      idempotencyKey: string;
      providers?: ProviderSetup | null;
    }) => applyTemplate(locationId, templateKey, idempotencyKey, providers),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin'] }),
  });
}
