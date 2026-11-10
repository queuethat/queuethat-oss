import { useMutation } from '@tanstack/react-query';
import { appConfig } from '../../../../lib/config.ts';
import { supabase } from '../../../../lib/supabase.ts';
import type { Dimension, Measure, ReportRow } from '../custom/api.ts';

export interface Answer {
  definition: { measures: Measure[]; dimensions: Dimension[]; from: string; to: string };
  rows: ReportRow[];
  /** Plain text written by the model from the aggregate rows; render it as text only. */
  summary: string | null;
  /** Questions left today for the org. */
  remaining: number;
}

/**
 * Asks the `ask-analytics` Edge Function with the signed-in user's own token. Rejects with
 * Error(<code>): `analytics_disabled`, `rate_limited`, `couldnt_answer`, `invalid_input`,
 * `permission_denied`, `llm_unavailable`, `unknown`.
 */
export function useAskAnalytics(orgId: string) {
  return useMutation({
    mutationFn: async (input: { question: string; locationId?: string }): Promise<Answer> => {
      const { data: session } = await supabase.auth.getSession();
      const { supabaseUrl, supabaseAnonKey } = appConfig();
      const response = await fetch(`${supabaseUrl}/functions/v1/ask-analytics`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.session?.access_token ?? ''}`,
          apikey: supabaseAnonKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          org_id: orgId,
          question: input.question,
          ...(input.locationId ? { location_id: input.locationId } : {}),
        }),
      });
      const body = (await response.json().catch(() => null)) as
        (Answer & { error?: string }) | null;
      if (!response.ok || !body) throw new Error(body?.error ?? 'unknown');
      return body;
    },
  });
}
