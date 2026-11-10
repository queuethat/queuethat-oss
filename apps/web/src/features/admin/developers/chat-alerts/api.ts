import { errorCode } from '@qm/domain';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../../../lib/supabase.ts';
import { useCreateEndpoint, type WebhookEvent } from '../webhooks/api.ts';

/** The chat apps an endpoint can post to; the database checks the URL host against the kind. */
export const CHAT_KINDS = ['slack', 'discord', 'teams'] as const;
export type ChatKind = (typeof CHAT_KINDS)[number];

/** The alerts an admin can pick, each mapped to the webhook event that carries it. */
export const CHAT_ALERTS = [
  { key: 'joined', event: 'visit.joined' },
  { key: 'queueLong', event: 'queue.long' },
  { key: 'deliveryFailed', event: 'delivery.dead' },
  { key: 'queueClosed', event: 'queue.state_changed' },
] as const satisfies readonly { key: string; event: WebhookEvent }[];
export type ChatAlertKey = (typeof CHAT_ALERTS)[number]['key'];

const chatKey = (orgId: string) => ['admin', 'chat-alerts', orgId];

/** The org's Slack, Discord and Teams endpoints with their alert thresholds, newest first. */
export const chatEndpointsQuery = (orgId: string) =>
  queryOptions({
    queryKey: chatKey(orgId),
    queryFn: async () => {
      const { data, error } = await supabase
        .schema('app')
        .from('webhook_endpoints')
        .select('id, url, kind, event_types, active, alert_thresholds, created_at')
        .eq('org_id', orgId)
        .in('kind', [...CHAT_KINDS])
        .order('created_at', { ascending: false });
      if (error) throw new Error(errorCode(error));
      return data;
    },
  });

/**
 * Connects a chat channel: `api.create_webhook_endpoint` for the chosen alerts, then
 * `api.set_webhook_alert_thresholds` when "queue is long" is on. Errors: `invalid_url` (not that
 * app's webhook address), `invalid_input`, `permission_denied`.
 */
export function useConnectChat(orgId: string) {
  const queryClient = useQueryClient();
  const create = useCreateEndpoint(orgId);
  return useMutation({
    mutationFn: async (input: {
      url: string;
      kind: ChatKind;
      alerts: ChatAlertKey[];
      waiting: number;
    }) => {
      const { id } = await create.mutateAsync({
        url: input.url,
        kind: input.kind,
        eventTypes: CHAT_ALERTS.filter((a) => input.alerts.includes(a.key)).map((a) => a.event),
        includeGuestName: false,
      });
      if (input.alerts.includes('queueLong')) {
        const { error } = await supabase.rpc('set_webhook_alert_thresholds', {
          p_endpoint_id: id,
          p_thresholds: { waiting: input.waiting },
        });
        if (error) throw new Error(errorCode(error));
      }
      return id;
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: chatKey(orgId) }),
  });
}
