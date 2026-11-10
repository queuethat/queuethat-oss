import { errorCode } from '@qm/domain';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../../../lib/supabase.ts';

export interface QueueLook {
  id: string;
  name: string;
  /** `#rrggbb`, or null to use the organization's accent. */
  accent: string | null;
  /** At most 280 characters, or null to use the location's. */
  welcomeText: string | null;
}

export const WELCOME_MAX = 280;

export const queueLookQuery = (queueId: string) =>
  queryOptions({
    queryKey: ['admin', 'queue-look', queueId],
    queryFn: async (): Promise<QueueLook> => {
      const { data, error } = await supabase
        .schema('app')
        .from('queues')
        .select('id, name, brand_accent, welcome_text')
        .eq('id', queueId)
        .single();
      if (error) throw new Error(errorCode(error));
      return {
        id: data.id,
        name: data.name,
        accent: data.brand_accent,
        welcomeText: data.welcome_text,
      };
    },
  });

/** Saves the queue's accent and welcome text; empty values clear the override. */
export function useSaveQueueLook(queueId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ accent, welcomeText }: { accent: string; welcomeText: string }) => {
      const { error } = await supabase
        .schema('app')
        .from('queues')
        .update({ brand_accent: accent || null, welcome_text: welcomeText.trim() || null })
        .eq('id', queueId);
      if (error) throw new Error(errorCode(error));
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin'] }),
  });
}
