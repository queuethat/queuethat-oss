import { errorCode } from '@qm/domain';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../../lib/supabase.ts';

/** What an admin edits on a service (A6, #46). Expected minutes drive the ETA. */
export interface ServiceSettings {
  name: string;
  description: string;
  expectedMinutes: number;
  /** `#rrggbb`, or null for no colour. */
  color: string | null;
  /** Inactive services stay on record but guests can't pick them. */
  active: boolean;
  /** 1 to 3 capital letters that replace the queue's ticket prefix; empty uses the queue's. */
  ticketPrefix: string;
  /** Resources that can serve it (2A-Q3); empty means anyone. */
  resourceIds: string[];
}

export interface ServiceRow extends ServiceSettings {
  id: string;
}

export const NEW_SERVICE: ServiceSettings = {
  name: '',
  description: '',
  expectedMinutes: 10,
  color: null,
  active: true,
  ticketPrefix: '',
  resourceIds: [],
};

const servicesKey = (queueId: string) => ['admin', 'services', queueId];

/** A queue, with all its services (active first), read under RLS. */
export const queueServicesQuery = (queueId: string) =>
  queryOptions({
    queryKey: servicesKey(queueId),
    queryFn: async () => {
      const { data, error } = await supabase
        .schema('app')
        .from('queues')
        .select(
          'id, org_id, location_id, name, ticket_prefix, services(id, name, description, expected_minutes, color, active, sort_order, ticket_prefix, service_resources(counter_id))',
        )
        .eq('id', queueId)
        .single();
      if (error) throw error;
      const services: ServiceRow[] = data.services
        .sort(
          (a, b) =>
            Number(b.active) - Number(a.active) ||
            a.sort_order - b.sort_order ||
            a.name.localeCompare(b.name),
        )
        .map((s) => ({
          id: s.id,
          name: s.name,
          description: s.description ?? '',
          expectedMinutes: s.expected_minutes,
          color: s.color,
          active: s.active,
          ticketPrefix: s.ticket_prefix ?? '',
          resourceIds: s.service_resources.map((r) => r.counter_id),
        }));
      return {
        queue: {
          id: data.id,
          orgId: data.org_id,
          locationId: data.location_id,
          name: data.name,
          ticketPrefix: data.ticket_prefix,
        },
        services,
      };
    },
  });

const columns = (s: ServiceSettings) => ({
  name: s.name.trim(),
  description: s.description.trim() || null,
  expected_minutes: s.expectedMinutes,
  color: s.color,
  active: s.active,
  ticket_prefix: s.ticketPrefix.trim().toUpperCase() || null,
});

type Change =
  | { kind: 'create'; settings: ServiceSettings }
  | { kind: 'update'; id: string; settings: ServiceSettings }
  | { kind: 'setActive'; id: string; active: boolean };

/**
 * Creates or edits a queue's services under RLS (managers and up, `services_*` policies). There
 * is no delete: deactivating hides a service from the join page and keeps past visits' history.
 * A row RLS hides fails as `permission_denied`.
 */
export function useChangeService(queue: { id: string; orgId: string; locationId: string }) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (change: Change) => {
      const services = supabase.schema('app').from('services');
      const { data, error } =
        change.kind === 'create'
          ? await services
              .insert({
                org_id: queue.orgId,
                location_id: queue.locationId,
                queue_id: queue.id,
                ...columns(change.settings),
              })
              .select('id')
          : await services
              .update(
                change.kind === 'update' ? columns(change.settings) : { active: change.active },
              )
              .eq('id', change.id)
              .select('id');
      if (error) throw new Error(errorCode(error));
      if (data.length === 0) throw new Error('permission_denied');
      if (change.kind !== 'setActive') {
        await setResources(queue, data[0]!.id, change.settings.resourceIds);
      }
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: servicesKey(queue.id) }),
  });
}

/**
 * Makes `resourceIds` the resources that can serve the service: drops the others and adds the
 * missing ones (managers and up, `service_resources_*` policies). Empty means anyone can.
 */
async function setResources(
  queue: { orgId: string; locationId: string },
  serviceId: string,
  resourceIds: string[],
) {
  const table = supabase.schema('app').from('service_resources');
  const drop = table.delete().eq('service_id', serviceId);
  const { error: dropError } = resourceIds.length
    ? await drop.not('counter_id', 'in', `(${resourceIds.join(',')})`)
    : await drop;
  if (dropError) throw new Error(errorCode(dropError));
  if (resourceIds.length === 0) return;
  const { error } = await table.upsert(
    resourceIds.map((counter_id) => ({
      org_id: queue.orgId,
      location_id: queue.locationId,
      service_id: serviceId,
      counter_id,
    })),
    { onConflict: 'service_id,counter_id', ignoreDuplicates: true },
  );
  if (error) throw new Error(errorCode(error));
}
