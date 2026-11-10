const CUSTOMER_ID = /^cus_[A-Za-z0-9]+$/;
const DEFAULT_DASHBOARD = 'https://dashboard.stripe.com';

/**
 * The Stripe dashboard page for a customer, or null when there is no customer id or it is not
 * shaped like one. `dashboard` is the dashboard's base address (`…/test` for a sandbox); anything
 * that is not https falls back to the live dashboard. Only the customer id goes into the link.
 */
export function stripeCustomerUrl(customerId: string | null, dashboard: string): string | null {
  if (!customerId || !CUSTOMER_ID.test(customerId)) return null;
  const base = /^https:\/\/[^\s?#]+$/.test(dashboard.trim())
    ? dashboard.trim().replace(/\/+$/, '')
    : DEFAULT_DASHBOARD;
  return `${base}/customers/${customerId}`;
}
