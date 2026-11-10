import { errorCode } from '@qm/domain';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../../../lib/supabase.ts';

/** Events an endpoint can subscribe to (mirrors the table check). */
export const WEBHOOK_EVENTS = [
  'visit.joined',
  'visit.called',
  'visit.recalled',
  'visit.serving',
  'visit.served',
  'visit.no_show',
  'visit.cancelled',
  'visit.removed',
  'visit.requeued',
  'visit.expired',
  'visit.reinstated',
  'visit.checked_in',
  'queue.state_changed',
  'queue.long',
  'delivery.dead',
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];
export const WEBHOOK_KINDS = ['generic', 'slack', 'discord', 'teams'] as const;
export type WebhookKind = (typeof WEBHOOK_KINDS)[number];

/** Endpoints and their deliveries are readable only by org-wide owners and admins. */
export const canManageWebhooks = (role: string | undefined) => role === 'admin' || role === 'owner';

export type EndpointStatus = 'active' | 'failing' | 'disabled';
/** Disabled wins; an active endpoint with recent consecutive failures is failing. */
export const endpointStatus = (e: {
  active: boolean;
  consecutive_failures: number;
}): EndpointStatus => (!e.active ? 'disabled' : e.consecutive_failures > 0 ? 'failing' : 'active');

const endpointsKey = (orgId: string) => ['admin', 'webhooks', orgId];
const deliveriesKey = (endpointId: string) => ['admin', 'webhook-deliveries', endpointId];

/** The org's endpoints, newest first. Signing secrets are never readable. */
export const endpointsQuery = (orgId: string) =>
  queryOptions({
    queryKey: endpointsKey(orgId),
    queryFn: async () => {
      const { data, error } = await supabase
        .schema('app')
        .from('webhook_endpoints')
        .select(
          'id, url, kind, event_types, include_guest_name, active, consecutive_failures, disabled_reason, created_at',
        )
        .eq('org_id', orgId)
        .order('created_at', { ascending: false });
      if (error) throw new Error(errorCode(error));
      return data;
    },
  });

/** An endpoint's last 50 deliveries, newest first, with the payload that was (or will be) sent. */
export const deliveriesQuery = (endpointId: string) =>
  queryOptions({
    queryKey: deliveriesKey(endpointId),
    refetchInterval: 10_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .schema('app')
        .from('webhook_deliveries')
        .select('id, event_type, status, attempts, response_status, error, payload, created_at')
        .eq('endpoint_id', endpointId)
        .order('created_at', { ascending: false })
        .limit(50);
      if (error) throw new Error(errorCode(error));
      return data;
    },
  });

export interface CreateEndpointInput {
  url: string;
  kind: WebhookKind;
  eventTypes: WebhookEvent[];
  includeGuestName: boolean;
}

/**
 * `api.create_webhook_endpoint`. Resolves with the signing secret, which exists only in this
 * result. Errors: `invalid_url` (https only), `invalid_input`, `permission_denied`, `not_found`.
 */
export function useCreateEndpoint(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateEndpointInput) => {
      const { data, error } = await supabase.rpc('create_webhook_endpoint', {
        p_org_id: orgId,
        p_url: input.url.trim(),
        p_kind: input.kind,
        p_event_types: input.eventTypes,
        p_include_guest_name: input.includeGuestName,
        p_idempotency_key: crypto.randomUUID(),
      });
      if (error) throw new Error(errorCode(error));
      return data as { id: string; secret: string };
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: endpointsKey(orgId) }),
  });
}

/** `api.rotate_webhook_secret`: a new secret, shown once; the old one signs for 24 more hours. */
export function useRotateSecret() {
  return useMutation({
    mutationFn: async (endpointId: string) => {
      const { data, error } = await supabase.rpc('rotate_webhook_secret', {
        p_endpoint_id: endpointId,
      });
      if (error) throw new Error(errorCode(error));
      return data as { id: string; secret: string };
    },
  });
}

/** `api.redeliver_webhook`: queues a finished delivery again from the start. */
export function useRedeliver(endpointId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (deliveryId: string) => {
      const { error } = await supabase.rpc('redeliver_webhook', { p_delivery_id: deliveryId });
      if (error) throw new Error(errorCode(error));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: deliveriesKey(endpointId) }),
  });
}

/** `api.send_webhook_test`: queues a `ping` event to the endpoint; it shows up in the delivery log. */
export function useSendTest(endpointId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc('send_webhook_test', { p_endpoint_id: endpointId });
      if (error) throw new Error(errorCode(error));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: deliveriesKey(endpointId) }),
  });
}

/**
 * `api.set_webhook_active`: pauses or re-enables an endpoint. Re-enabling clears its failure
 * count and disabled reason, and queued deliveries resume.
 */
export function useSetActive(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ endpointId, active }: { endpointId: string; active: boolean }) => {
      const { error } = await supabase.rpc('set_webhook_active', {
        p_endpoint_id: endpointId,
        p_active: active,
      });
      if (error) throw new Error(errorCode(error));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: endpointsKey(orgId) }),
  });
}
