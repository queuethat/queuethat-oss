import type { Json } from '@qm/db-types';
import { errorCode } from '@qm/domain';
import { queryOptions } from '@tanstack/react-query';
import { supabase } from '../../../lib/supabase.ts';
import type { OrgStatus } from '../api.ts';

// #1131: the support console's billing reads. One query per RPC; both need a platform role of
// support or higher and an aal2 session, and neither returns card data or guest data.

/** Why the org has the plan it has: the database decides, the page only words it. */
export type BillingStanding = 'billing_off' | 'no_subscription' | 'good' | 'grace' | 'free';

export interface EntitlementValue {
  key: string;
  value: Json;
  /** Where the resolver took the value from. */
  source: 'override' | 'plan' | 'default';
}
export interface BillingOverride {
  key: string;
  value: Json;
  reason: string;
  /** The operator's email, or null when that account no longer exists. */
  set_by_email: string | null;
  set_at: string;
}
export interface BillingJob {
  status: 'queued' | 'claimed' | 'failed' | 'dead';
  attempts: number;
  next_attempt_at: string;
  /** A provider error code only. */
  last_error: string | null;
  created_at: string;
}

/**
 * `api.platform_org_billing` with its jsonb parts typed as the RPC's comment documents them.
 * Generated composite types make every field nullable; these are the ones that really can be.
 */
export interface OrgBilling {
  billing_enabled: boolean;
  org_status: OrgStatus;
  has_subscription: boolean;
  plan_id: string | null;
  plan_name: string | null;
  effective_plan: string | null;
  billing_interval: 'month' | 'year' | null;
  status: string | null;
  standing: BillingStanding;
  current_period_end: string | null;
  locations_billed: number | null;
  locations_wanted: number | null;
  locations_actual: number;
  grace_ends_at: string | null;
  last_payment_failed_at: string | null;
  grace_reminder_at: string | null;
  stripe_customer_id: string | null;
  entitlements: EntitlementValue[];
  overrides: BillingOverride[];
  pending_jobs: BillingJob[];
}

/** One tenant's plan, standing, limits, overrides and unfinished syncs. */
export const orgBillingQuery = (orgId: string) =>
  queryOptions({
    queryKey: ['platform', 'billing', orgId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('platform_org_billing', { p_org_id: orgId });
      if (error) throw new Error(errorCode(error));
      return data as unknown as OrgBilling;
    },
  });

export interface AttentionItem {
  org_id: string;
  name: string;
  reason: 'past_due' | 'canceled' | 'trial_ending';
  at: string | null;
}
/** `api.platform_billing_overview`: counts and the orgs behind them. */
export interface BillingOverview {
  billing_enabled: boolean;
  past_due: number;
  canceled_30d: number;
  trials_ending_7d: number;
  attention: AttentionItem[];
}

/** Past-due, canceled and trial-ending counts for the support queue. */
export const billingOverviewQuery = queryOptions({
  queryKey: ['platform', 'billing-overview'],
  queryFn: async () => {
    const { data, error } = await supabase.rpc('platform_billing_overview');
    if (error) throw new Error(errorCode(error));
    return data as unknown as BillingOverview;
  },
  refetchInterval: 60_000,
});
