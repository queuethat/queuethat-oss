import { errorCode } from '@qm/domain';
import { queryOptions, useMutation } from '@tanstack/react-query';
import { appConfig } from '../../../lib/config.ts';
import { supabase } from '../../../lib/supabase.ts';

export type Interval = 'month' | 'year';

/** One plan as `api.org_billing` lists it. A limit of -1 is unlimited. */
export interface BillingPlan {
  id: string;
  name: string;
  unitPriceMinor: number;
  /** Per location per year; null while the plan has no annual price. */
  unitPriceAnnualMinor: number | null;
  currency: string;
  maxLocations: number;
  maxMembers: number;
  /** SMS and WhatsApp may be switched on. */
  paidChannels: boolean;
}

export interface OrgBilling {
  /** False while billing is off (self-host): there is nothing to show. */
  enabled: boolean;
  planId: string | null;
  planName: string | null;
  unitPriceMinor: number;
  currency: string;
  locations: number;
  /** Stripe holds a live subscription. */
  subscribed: boolean;
  status: string | null;
  currentPeriodEnd: string | null;
  graceEndsAt: string | null;
  /** Every plan, cheapest first, with the limits the database enforces. */
  plans: BillingPlan[];
  /** This org may use SMS and WhatsApp (false on the free plan). */
  paidChannels: boolean;
  /** How a live subscription is billed. */
  billingInterval: Interval;
}

/** Plan, price per location, locations and Stripe's state, from `api.org_billing` (owners only). */
export const orgBillingQuery = (orgId: string) =>
  queryOptions({
    queryKey: ['admin', 'billing', orgId],
    queryFn: async (): Promise<OrgBilling> => {
      const { data, error } = await supabase.rpc('org_billing', { p_org_id: orgId });
      if (error) throw new Error(errorCode(error));
      const r = data[0];
      return {
        enabled: r?.enabled ?? false,
        planId: r?.plan_id ?? null,
        planName: r?.plan_name ?? null,
        unitPriceMinor: r?.unit_price_minor ?? 0,
        currency: r?.currency ?? 'usd',
        locations: r?.locations ?? 0,
        subscribed: r?.subscribed ?? false,
        status: r?.status ?? null,
        currentPeriodEnd: r?.current_period_end ?? null,
        graceEndsAt: r?.grace_ends_at ?? null,
        plans: (r?.plans as BillingPlan[] | null) ?? [],
        paidChannels: r?.paid_channels ?? false,
        billingInterval: r?.billing_interval === 'year' ? 'year' : 'month',
      };
    },
  });

export const TOPUP_AMOUNTS = [1000, 2500, 5000] as const;

export interface CreditEntry {
  id: string;
  createdAt: string;
  type: 'topup' | 'debit' | 'adjustment' | 'addon_allowance';
  amountMicros: number;
  costMicros: number;
  marginMicros: number;
}

export interface Credit {
  balanceMicros: number;
  entries: CreditEntry[];
}

/** Prepaid SMS credit: the balance and the latest ledger entries, cost and margin apart (admins and owners). */
export const creditQuery = (orgId: string) =>
  queryOptions({
    queryKey: ['admin', 'billing', orgId, 'credit'],
    queryFn: async (): Promise<Credit> => {
      const app = supabase.schema('app');
      const [balance, ledger] = await Promise.all([
        app.from('credit_balance').select('balance_micros').eq('org_id', orgId).maybeSingle(),
        app
          .from('credit_ledger')
          .select('id, created_at, entry_type, amount_micros, cost_micros, margin_micros')
          .eq('org_id', orgId)
          .neq('amount_micros', 0)
          .order('created_at', { ascending: false })
          .limit(20),
      ]);
      if (balance.error || ledger.error) throw new Error('unknown');
      return {
        balanceMicros: Number(balance.data?.balance_micros ?? 0),
        entries: (ledger.data ?? []).map((r) => ({
          id: r.id,
          createdAt: r.created_at,
          type: r.entry_type as CreditEntry['type'],
          amountMicros: Number(r.amount_micros),
          costMicros: Number(r.cost_micros),
          marginMicros: Number(r.margin_micros),
        })),
      };
    },
  });

/**
 * Opens Stripe for the org: the Customer Portal when it has a subscription, Checkout when it does
 * not. The `billing` function decides who may; the browser is sent to the returned address.
 */
export function useOpenBilling(orgId: string) {
  return useMutation({
    mutationFn: async (
      request: 'portal' | { checkout: Interval } | { topup: number },
    ): Promise<string> => {
      const kind =
        typeof request === 'string' ? request : 'checkout' in request ? 'checkout' : 'topup';
      const { data: session } = await supabase.auth.getSession();
      const { supabaseUrl, supabaseAnonKey } = appConfig();
      const response = await fetch(`${supabaseUrl}/functions/v1/billing/${kind}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.session?.access_token ?? ''}`,
          apikey: supabaseAnonKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          org_id: orgId,
          ...(typeof request === 'object' && 'topup' in request
            ? { amount_minor: request.topup }
            : {}),
          ...(typeof request === 'object' && 'checkout' in request
            ? { interval: request.checkout }
            : {}),
        }),
      });
      const body = (await response.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!response.ok || !body.url) throw new Error(body.error ?? 'unknown');
      return body.url;
    },
    onSuccess: (url) => window.location.assign(url),
  });
}
