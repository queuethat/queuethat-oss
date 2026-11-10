import { errorCode } from '@qm/domain';
import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';
import { supabase } from '../../../lib/supabase.ts';

// #1130: the support console's delivery log. One query per RPC. The database masks recipients
// and returns no bodies, so nothing here can show more than it is given.

/** Rows per page of the log. */
export const DELIVERIES_PAGE = 50;

/** One row of `api.platform_org_deliveries`; generated composite types make every field nullable. */
export interface Delivery {
  kind: 'message' | 'webhook';
  id: string;
  org_id: string;
  org_name: string;
  created_at: string;
  updated_at: string;
  medium: string;
  template_key: string;
  status: string;
  delivery_status: string | null;
  error_code: string | null;
  attempts: number;
  provider: string | null;
  suppression_reason: string | null;
  recipient_masked: string | null;
}

export interface DeliveryFilter {
  /** Null lists failures across every business. */
  orgId: string | null;
  status?: string | undefined;
  medium?: string | undefined;
  /** ISO instants; the range is [from, to). */
  from?: string | undefined;
  to?: string | undefined;
}

interface Cursor {
  at: string;
  id: string;
}

/** The log, newest first, one cursor-paged request per page (`api.platform_org_deliveries`). */
export const deliveriesQuery = (f: DeliveryFilter) =>
  infiniteQueryOptions({
    queryKey: [
      'platform',
      'deliveries',
      f.orgId,
      f.status ?? '',
      f.medium ?? '',
      f.from ?? '',
      f.to ?? '',
    ],
    initialPageParam: null as Cursor | null,
    queryFn: async ({ pageParam }) => {
      const { data, error } = await supabase.rpc('platform_org_deliveries', {
        // Generated args are non-null `string`; the null org (all tenants) is part of the contract.
        p_org_id: f.orgId as string,
        p_limit: DELIVERIES_PAGE,
        ...(f.status ? { p_status: f.status } : {}),
        ...(f.medium ? { p_channel: f.medium } : {}),
        ...(f.from ? { p_from: f.from } : {}),
        ...(f.to ? { p_to: f.to } : {}),
        ...(pageParam ? { p_after_at: pageParam.at, p_after_id: pageParam.id } : {}),
      });
      if (error) throw new Error(errorCode(error));
      return data as unknown as Delivery[];
    },
    // A short page is the last one; a full page may have more.
    getNextPageParam: (last): Cursor | undefined => {
      const tail = last[last.length - 1];
      return last.length < DELIVERIES_PAGE || !tail
        ? undefined
        : { at: tail.created_at, id: tail.id };
    },
  });

export interface SummaryRow {
  medium: string;
  provider: string;
  sent: number;
  failed: number;
  suppressed: number;
  pending: number;
  failure_rate: number;
}

/** Counts by channel and provider across all businesses (`api.platform_delivery_summary`). */
export const deliverySummaryQuery = (from: string, to: string) =>
  queryOptions({
    queryKey: ['platform', 'delivery-summary', from, to],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('platform_delivery_summary', {
        p_from: from,
        p_to: to,
      });
      if (error) throw new Error(errorCode(error));
      return data as unknown as SummaryRow[];
    },
    refetchInterval: 60_000,
  });
