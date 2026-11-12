import { errorCode } from '@qm/domain';
import { infiniteQueryOptions } from '@tanstack/react-query';
import { supabase } from '../../../lib/supabase.ts';

/** What happened to one text, as the database decides it (`private.text_outcome`). */
export type TextOutcome =
  'delivered' | 'sent' | 'sending' | 'quiet_hours' | 'blocked_stop' | 'not_sent' | 'failed';

export interface RecentText {
  id: string;
  createdAt: string;
  template: string;
  outcome: TextOutcome;
  /** Error code when not sent or failed. */
  reason: string | null;
  /** Last two digits of the number. */
  numberHint: string | null;
  ticket: string | null;
}

/**
 * The location's texts of the last 7 days, newest first, 50 a page (`api.list_recent_texts`). Managers
 * and above. Masked numbers and outcomes only: never a body or a full number.
 */
export const recentTextsQuery = (locationId: string) =>
  infiniteQueryOptions({
    queryKey: ['admin', 'recent-texts', locationId],
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: RecentText[]) =>
      last.length === 50 ? last[last.length - 1]?.createdAt : undefined,
    queryFn: async ({ pageParam }): Promise<RecentText[]> => {
      const { data, error } = await supabase.rpc('list_recent_texts', {
        p_location_id: locationId,
        ...(pageParam ? { p_before: pageParam } : {}),
      });
      if (error) throw new Error(errorCode(error));
      return (data ?? []).map((r) => ({
        id: r.id!,
        createdAt: r.created_at!,
        template: r.template!,
        outcome: r.outcome as TextOutcome,
        reason: r.reason,
        numberHint: r.number_hint,
        ticket: r.ticket,
      }));
    },
  });
