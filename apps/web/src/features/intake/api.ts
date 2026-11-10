import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useLiveQuery } from '../../lib/live.ts';
import { supabase } from '../../lib/supabase.ts';
import type { IntakeField } from './fields.ts';

/** A field as staff see it: guest-visible ones are read-only, `staffOnly` ones are theirs to fill. */
export interface StaffField extends IntakeField {
  staffOnly: boolean;
}

export interface VisitAnswers {
  locationId: string | null;
  fields: StaffField[];
  answers: Record<string, string | number | boolean>;
}

/**
 * The questions of the visit's queue and its answers, for the console detail sheet. Kept live by
 * the location signal, so a second tablet sees an answer another tablet saved within seconds.
 */
export function useVisitAnswers(visit: { id: string }) {
  return useLiveQuery({
    topic: (data: VisitAnswers | undefined) => (data?.locationId ? `loc:${data.locationId}` : null),
    queryKey: ['console', 'answers', visit.id],
    queryFn: async (): Promise<VisitAnswers> => {
      // The sheet is opened from the list and from search, so it asks for the visit's queue itself.
      const { data: row, error: rowError } = await supabase
        .schema('app')
        .from('staff_visits')
        .select('queue_id')
        .eq('id', visit.id)
        .single();
      if (rowError) throw rowError;
      const [fields, answers] = await Promise.all([
        supabase
          .schema('app')
          .from('intake_fields')
          .select('location_id, key, label, help, type, options, required, visibility')
          .eq('queue_id', row.queue_id)
          .eq('active', true)
          .order('position')
          .order('key'),
        supabase
          .schema('app')
          .from('visit_answers')
          .select('answers')
          .eq('visit_id', visit.id)
          .maybeSingle(),
      ]);
      if (fields.error) throw fields.error;
      if (answers.error) throw answers.error;
      return {
        locationId: fields.data[0]?.location_id ?? null,
        fields: fields.data.map((f) => ({
          key: f.key,
          label: f.label,
          help: f.help,
          type: f.type,
          options: Array.isArray(f.options) ? f.options.map(String) : null,
          required: f.required,
          staffOnly: f.visibility === 'staff_only',
        })),
        answers: (answers.data?.answers ?? {}) as VisitAnswers['answers'],
      };
    },
    jitterMs: 0,
  });
}

/**
 * Replaces the visit's answers (`set_visit_answers`), sent whole with the version the console last
 * saw: a stale tap fails as `stale_visit` rather than overwriting another tablet's change.
 */
export function useSetVisitAnswers(visit: { id: string; version: number }) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (answers: VisitAnswers['answers']) => {
      const { error } = await supabase.rpc('set_visit_answers', {
        p_visit_id: visit.id,
        p_answers: answers,
        p_expected_version: visit.version,
        p_idempotency_key: crypto.randomUUID(),
      });
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['console', 'answers', visit.id] }),
  });
}
