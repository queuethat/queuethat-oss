import { errorCode } from '@qm/domain';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../../lib/supabase.ts';

export interface JourneyStep {
  queueId: string;
  serviceId: string | null;
}

export interface JourneyRow {
  id: string;
  name: string;
  steps: JourneyStep[];
  /** Services whose guests follow this journey. */
  serviceIds: string[];
}

export interface JourneyService {
  id: string;
  name: string;
  queueName: string;
}

const key = (locationId: string) => ['admin', 'journeys', locationId] as const;

/** The location's journeys with their ordered steps, and the services that use each. */
export const journeysQuery = (locationId: string) =>
  queryOptions({
    queryKey: key(locationId),
    queryFn: async (): Promise<{ journeys: JourneyRow[]; services: JourneyService[] }> => {
      const [journeys, services] = await Promise.all([
        supabase
          .schema('app')
          .from('journeys')
          .select('id, name, journey_steps(step_no, queue_id, service_id)')
          .eq('location_id', locationId)
          .order('created_at'),
        supabase
          .schema('app')
          .from('services')
          .select('id, name, journey_id, queues(name)')
          .eq('location_id', locationId)
          .eq('active', true)
          .order('name'),
      ]);
      if (journeys.error) throw new Error(errorCode(journeys.error));
      if (services.error) throw new Error(errorCode(services.error));
      return {
        journeys: journeys.data.map((j) => ({
          id: j.id,
          name: j.name,
          steps: [...j.journey_steps]
            .sort((a, b) => a.step_no - b.step_no)
            .map((s) => ({ queueId: s.queue_id, serviceId: s.service_id })),
          serviceIds: services.data.filter((s) => s.journey_id === j.id).map((s) => s.id),
        })),
        services: services.data.map((s) => ({
          id: s.id,
          name: s.name,
          queueName: s.queues?.name ?? '',
        })),
      };
    },
  });

/** Creates or replaces a journey: its steps in order and the services that follow it. */
export function useSaveJourney(orgId: string, locationId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (j: {
      id?: string;
      name: string;
      queueIds: string[];
      serviceIds: string[];
    }) => {
      const table = supabase.schema('app');
      let id = j.id;
      if (id) {
        const { error } = await table.from('journeys').update({ name: j.name }).eq('id', id);
        if (error) throw new Error(errorCode(error));
        const gone = await table.from('journey_steps').delete().eq('journey_id', id);
        if (gone.error) throw new Error(errorCode(gone.error));
      } else {
        const { data, error } = await table
          .from('journeys')
          .insert({ org_id: orgId, location_id: locationId, name: j.name })
          .select('id')
          .single();
        if (error) throw new Error(errorCode(error));
        id = data.id;
      }
      const steps = await table.from('journey_steps').insert(
        j.queueIds.map((queueId, i) => ({
          journey_id: id!,
          org_id: orgId,
          step_no: i + 1,
          queue_id: queueId,
        })),
      );
      if (steps.error) throw new Error(errorCode(steps.error));
      const cleared = await table
        .from('services')
        .update({ journey_id: null })
        .eq('journey_id', id);
      if (cleared.error) throw new Error(errorCode(cleared.error));
      if (j.serviceIds.length > 0) {
        const set = await table.from('services').update({ journey_id: id }).in('id', j.serviceIds);
        if (set.error) throw new Error(errorCode(set.error));
      }
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key(locationId) }),
  });
}

export function useDeleteJourney(locationId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.schema('app').from('journeys').delete().eq('id', id);
      if (error) throw new Error(errorCode(error));
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key(locationId) }),
  });
}
