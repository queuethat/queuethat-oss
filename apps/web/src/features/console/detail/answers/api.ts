import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useLiveQuery } from '../../../../lib/live.ts';
import { supabase } from '../../../../lib/supabase.ts';
import type { Answers } from '../../../guest/api.ts';
import { parseJoinForm, type FormField } from '../../../guest/formFields.ts';

/** A form field as staff see it: guest ones are read-only here, `staffOnly` ones are theirs to fill. */
export interface StaffFormField extends FormField {
  staffOnly: boolean;
}

export interface VisitAnswers {
  locationId: string;
  fields: StaffFormField[];
  answers: Answers;
}

const key = (visitId: string) => ['console', 'answers', visitId] as const;

/**
 * A visit's form and answers from `api.get_visit_answers`, the only read of answers: the database
 * logs every access there (who, when, visit). Kept live by the location signal, which carries no
 * answer values (I-5), so a second tablet sees an answer another saved within seconds.
 */
export function useVisitAnswers(visitId: string) {
  return useLiveQuery({
    topic: (data: VisitAnswers | undefined) => (data ? `loc:${data.locationId}` : null),
    queryKey: key(visitId),
    queryFn: async (): Promise<VisitAnswers> => {
      const { data, error } = await supabase.rpc('get_visit_answers', { p_visit_id: visitId });
      if (error) throw error;
      const raw = data as {
        location_id: string;
        fields: { key: string; visibility?: string }[];
        answers: Answers | null;
      };
      const staffOnly = new Set(
        raw.fields.filter((f) => f.visibility === 'staff_only').map((f) => f.key),
      );
      return {
        locationId: raw.location_id,
        fields: parseJoinForm(raw).map((f) => ({ ...f, staffOnly: staffOnly.has(f.key) })),
        answers: raw.answers ?? {},
      };
    },
    jitterMs: 0,
  });
}

/**
 * Replaces the visit's answers (`set_visit_answers`), sent whole with the version the console last
 * saw: a stale tap fails as `stale_visit` rather than overwriting another tablet's change. The
 * database validates and keeps whatever the guest signed.
 */
export function useSetVisitAnswers(visit: { id: string; version: number }) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (answers: Answers) => {
      const { error } = await supabase.rpc('set_visit_answers', {
        p_visit_id: visit.id,
        p_answers: answers,
        p_expected_version: visit.version,
        p_idempotency_key: crypto.randomUUID(),
      });
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key(visit.id) }),
  });
}
