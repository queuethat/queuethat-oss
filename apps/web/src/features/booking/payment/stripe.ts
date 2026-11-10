// Stripe.js loaded on demand, only on the payment step, so no other guest page downloads it or
// lets it run. The Payment Element renders in Stripe's iframe: card data never touches our origin.
const SRC = 'https://js.stripe.com/v3/';

export interface StripeElements {
  create(type: 'payment'): { mount(target: HTMLElement): void; destroy(): void };
}

interface StripeError {
  code?: string;
  type?: string;
}

export interface StripeJs {
  elements(options: { clientSecret: string }): StripeElements;
  confirmPayment(options: {
    elements: StripeElements;
    confirmParams: { return_url: string };
    redirect: 'if_required';
  }): Promise<{ error?: StripeError }>;
  confirmSetup(options: {
    elements: StripeElements;
    confirmParams: { return_url: string };
    redirect: 'if_required';
  }): Promise<{ error?: StripeError }>;
}

declare global {
  interface Window {
    Stripe?: (publishableKey: string) => StripeJs;
  }
}

let loading: Promise<void> | null = null;

function loadScript(): Promise<void> {
  if (window.Stripe) return Promise.resolve();
  loading ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SRC;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      script.remove();
      loading = null;
      reject(new Error('stripe_unavailable'));
    };
    document.head.append(script);
  });
  return loading;
}

/** Loads Stripe.js and returns a client for the publishable key. */
export async function loadStripe(publishableKey: string): Promise<StripeJs> {
  await loadScript();
  if (!window.Stripe) throw new Error('stripe_unavailable');
  return window.Stripe(publishableKey);
}
