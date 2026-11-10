import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';
import { supabase } from '../../../lib/supabase.ts';

export const COMMENT_PAGE = 20;

export interface FeedbackRange {
  locationId: string;
  /** Local dates, YYYY-MM-DD, both included. */
  from: string;
  to: string;
}

export interface FeedbackSummary {
  group: string;
  responses: number;
  avgRating: number | null;
  nps: number | null;
  promoters: number;
  passives: number;
  detractors: number;
  /** Served visits in the group; responses / served is the response rate. */
  served: number;
  /** Responses per rating, index 0 = one star. */
  ratings: number[];
}

export interface FeedbackComment {
  id: string;
  visitId: string;
  rating: number;
  nps: number | null;
  comment: string;
  createdAt: string;
  /** The guest's profile, which lists their visits; null when the visit has none. */
  guestId: string | null;
  ticket: string;
  service: string;
}

/** Rating and NPS aggregates from `api.feedback_summary`; the database owns every definition. */
export const feedbackSummaryQuery = (r: FeedbackRange, group: 'all' | 'week') =>
  queryOptions({
    queryKey: ['admin', 'feedback', 'summary', r, group],
    queryFn: async (): Promise<FeedbackSummary[]> => {
      const { data, error } = await supabase.rpc('feedback_summary', {
        p_location_id: r.locationId,
        p_from_day: r.from,
        p_to_day: r.to,
        p_group: group,
      });
      if (error) throw error;
      return data.map((s) => ({
        group: s.grp ?? '',
        responses: s.responses ?? 0,
        avgRating: s.avg_rating,
        nps: s.nps,
        promoters: s.promoters ?? 0,
        passives: s.passives ?? 0,
        detractors: s.detractors ?? 0,
        served: s.served ?? 0,
        ratings: [s.rating_1, s.rating_2, s.rating_3, s.rating_4, s.rating_5].map((n) => n ?? 0),
      }));
    },
  });

/** Comments newest first from `api.feedback_comments`, paged by the last id. */
export const feedbackCommentsQuery = (r: FeedbackRange) =>
  infiniteQueryOptions({
    queryKey: ['admin', 'feedback', 'comments', r],
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }): Promise<FeedbackComment[]> => {
      const { data, error } = await supabase.rpc('feedback_comments', {
        p_location_id: r.locationId,
        p_from_day: r.from,
        p_to_day: r.to,
        p_limit: COMMENT_PAGE,
        // The first page has no cursor; the generated type cannot express a null argument.
        p_after: pageParam as string,
      });
      if (error) throw error;
      return data.map((c) => ({
        id: c.id ?? '',
        visitId: c.visit_id ?? '',
        rating: c.rating ?? 0,
        nps: c.nps,
        comment: c.comment ?? '',
        createdAt: c.created_at ?? '',
        guestId: c.guest_id,
        ticket: c.ticket ?? '',
        service: c.service ?? '',
      }));
    },
    getNextPageParam: (last) =>
      last.length === COMMENT_PAGE ? (last[last.length - 1]?.id ?? null) : null,
  });
