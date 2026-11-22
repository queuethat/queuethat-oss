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
  /** The queues that offer it (app.queue_services). A service belongs to the location. */
  queueIds: string[];
}

export interface ServiceRow extends ServiceSettings {
  id: string;
}

export interface ServiceQueue {
  id: string;
  name: string;
  ticketPrefix: string;
}

export const NEW_SERVICE: ServiceSettings = {
  name: '',
  description: '',
  expectedMinutes: 10,
  color: null,
  active: true,
  ticketPrefix: '',
  resourceIds: [],
  queueIds: [],
};

const SERVICES_KEY = ['admin', 'services'];

/**
 * The location's services and its queues, read under RLS (A6, #46; location-level services, #75).
 * Services that were retired as a duplicate (`merged_into_id`) are left out; active ones come first.
 */
export const locationServicesQuery = (locationId: string) =>
  queryOptions({
    queryKey: [...SERVICES_KEY, 'location', locationId],
    queryFn: () => fetchLocationServices(locationId),
  });

async function fetchLocationServices(locationId: string) {
  const app = supabase.schema('app');
  const [location, queues, services] = await Promise.all([
    app.from('locations').select('id, org_id').eq('id', locationId).single(),
    app
      .from('queues')
      .select('id, name, ticket_prefix')
      .eq('location_id', locationId)
      .is('archived_at', null)
      .order('sort_order')
      .order('name'),
    app
      .from('services')
      .select(
        'id, name, description, expected_minutes, color, active, sort_order, ticket_prefix, service_resources(counter_id), queue_services(queue_id)',
      )
      .eq('location_id', locationId)
      .is('merged_into_id', null),
  ]);
  if (location.error) throw location.error;
  if (queues.error) throw queues.error;
  if (services.error) throw services.error;
  const rows: ServiceRow[] = services.data
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
      queueIds: s.queue_services.map((l) => l.queue_id),
    }));
  const queueList: ServiceQueue[] = queues.data.map((q) => ({
    id: q.id,
    name: q.name,
    ticketPrefix: q.ticket_prefix,
  }));
  return {
    scope: { orgId: location.data.org_id, locationId },
    queues: queueList,
    services: rows,
  };
}

/** One queue and the location's services, so the queue page can tick what it offers. */
export const queueServicesQuery = (queueId: string) =>
  queryOptions({
    queryKey: [...SERVICES_KEY, 'queue', queueId],
    queryFn: async () => {
      const { data, error } = await supabase
        .schema('app')
        .from('queues')
        .select('id, location_id')
        .eq('id', queueId)
        .single();
      if (error) throw error;
      const location = await fetchLocationServices(data.location_id);
      const queue = location.queues.find((q) => q.id === queueId);
      if (!queue) throw new Error('not_found');
      return { queue, ...location };
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
  | { kind: 'update'; id: string; settings: ServiceSettings; was: string[] }
  | { kind: 'setActive'; id: string; active: boolean };

/**
 * Creates or edits the location's services under RLS (managers and up, `services_*` and
 * `queue_services_*` policies). There is no delete: deactivating hides a service from the join page
 * and keeps past visits' history. A row RLS hides fails as `permission_denied`.
 */
export function useChangeService(scope: { orgId: string; locationId: string }) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (change: Change) => {
      const services = supabase.schema('app').from('services');
      const { data, error } =
        change.kind === 'create'
          ? await services
              .insert({
                org_id: scope.orgId,
                location_id: scope.locationId,
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
      if (change.kind === 'setActive') return;
      const id = data[0]!.id;
      await setResources(scope, id, change.settings.resourceIds);
      const was = change.kind === 'update' ? change.was : [];
      await setOffered(scope, id, was, change.settings.queueIds);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: SERVICES_KEY }),
  });
}

/** Ticks or unticks one queue for one service ("Offered here"). */
export function useToggleOffered(scope: { orgId: string; locationId: string }, queueId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ serviceId, offered }: { serviceId: string; offered: boolean }) => {
      await setOffered(scope, serviceId, offered ? [] : [queueId], offered ? [queueId] : []);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: SERVICES_KEY }),
  });
}

/** Makes the service offered by exactly `now`, given it was offered by `was`: adds and removes the difference. */
async function setOffered(
  scope: { orgId: string; locationId: string },
  serviceId: string,
  was: string[],
  now: string[],
) {
  const table = supabase.schema('app').from('queue_services');
  const gone = was.filter((id) => !now.includes(id));
  const added = now.filter((id) => !was.includes(id));
  if (gone.length > 0) {
    const { error } = await table.delete().eq('service_id', serviceId).in('queue_id', gone);
    if (error) throw new Error(errorCode(error));
  }
  if (added.length > 0) {
    const { error } = await table.upsert(
      added.map((queue_id) => ({
        org_id: scope.orgId,
        location_id: scope.locationId,
        queue_id,
        service_id: serviceId,
      })),
      { onConflict: 'queue_id,service_id', ignoreDuplicates: true },
    );
    if (error) throw new Error(errorCode(error));
  }
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
