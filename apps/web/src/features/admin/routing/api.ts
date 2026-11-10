import { errorCode } from '@qm/domain';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../../lib/supabase.ts';

export interface RoutingRule {
  id: string;
  rank: number;
  serviceId: string | null;
  fieldId: string | null;
  answerValue: string | null;
  targetQueueId: string;
  active: boolean;
}

export interface RoutingQueue {
  id: string;
  name: string;
}

export interface RoutingService {
  id: string;
  name: string;
  queueName: string;
}

/** An intake question of a queue; an answer condition must name one of the target queue's. */
export interface RoutingField {
  id: string;
  queueId: string;
  label: string;
}

export interface NewRoutingRule {
  serviceId: string | null;
  fieldId: string | null;
  answerValue: string;
  targetQueueId: string;
}

const key = (locationId: string) => ['admin', 'routing', locationId];

/** The location's routing rules (Q-11) with the queues, services and questions they can name. */
export const routingQuery = (locationId: string) =>
  queryOptions({
    queryKey: key(locationId),
    queryFn: async () => {
      const app = supabase.schema('app');
      const [rules, queues, services, fields] = await Promise.all([
        app
          .from('routing_rules')
          .select('id, rank, service_id, field_id, answer_value, target_queue_id, active')
          .eq('location_id', locationId)
          .order('rank')
          .order('created_at'),
        app
          .from('queues')
          .select('id, name')
          .eq('location_id', locationId)
          .is('archived_at', null)
          .order('sort_order')
          .order('name'),
        app
          .from('services')
          .select('id, name, queues(name)')
          .eq('location_id', locationId)
          .eq('active', true)
          .order('name'),
        app
          .from('intake_fields')
          .select('id, queue_id, label')
          .eq('location_id', locationId)
          .eq('active', true)
          .order('position'),
      ]);
      for (const r of [rules, queues, services, fields]) if (r.error) throw r.error;
      return {
        rules: rules.data!.map((r): RoutingRule => ({
          id: r.id,
          rank: r.rank,
          serviceId: r.service_id,
          fieldId: r.field_id,
          answerValue: r.answer_value,
          targetQueueId: r.target_queue_id,
          active: r.active,
        })),
        queues: queues.data! as RoutingQueue[],
        services: services.data!.map((s): RoutingService => ({
          id: s.id,
          name: s.name,
          queueName: s.queues?.name ?? '',
        })),
        fields: fields.data!.map((f): RoutingField => ({
          id: f.id,
          queueId: f.queue_id,
          label: f.label,
        })),
      };
    },
  });

type Change =
  | { kind: 'create'; rule: NewRoutingRule; rank: number }
  | { kind: 'setActive'; id: string; active: boolean }
  /** Gives the rules these ids, in this order, ranks 0, 1, 2… */
  | { kind: 'reorder'; ids: string[] };

/**
 * Adds, switches off or reorders rules under RLS (managers and up). Rules are never deleted, so a
 * rule that sent guests somewhere stays on record.
 */
export function useChangeRouting(where: { orgId: string; locationId: string }) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (change: Change) => {
      const app = supabase.schema('app');
      if (change.kind === 'reorder') {
        const results = await Promise.all(
          change.ids.map((id, rank) =>
            app.from('routing_rules').update({ rank }).eq('id', id).select('id'),
          ),
        );
        const failed = results.find((r) => r.error || r.data?.length === 0);
        if (failed) throw new Error(failed.error ? errorCode(failed.error) : 'permission_denied');
        return;
      }
      const result =
        change.kind === 'create'
          ? await app
              .from('routing_rules')
              .insert({
                org_id: where.orgId,
                location_id: where.locationId,
                rank: change.rank,
                service_id: change.rule.serviceId,
                field_id: change.rule.fieldId,
                answer_value: change.rule.fieldId ? change.rule.answerValue.trim() : null,
                target_queue_id: change.rule.targetQueueId,
              })
              .select('id')
          : await app
              .from('routing_rules')
              .update({ active: change.active })
              .eq('id', change.id)
              .select('id');
      if (result.error) throw new Error(errorCode(result.error));
      if (result.data.length === 0) throw new Error('permission_denied');
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: key(where.locationId) }),
  });
}
