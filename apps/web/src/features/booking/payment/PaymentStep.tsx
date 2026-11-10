import { Button, Card, Spinner } from '@qm/ui';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from '../../../lib/translation.tsx';
import { formatMoney } from '../../admin/payments/money.ts';
import type { PaymentIntentInfo } from './api.ts';
import { loadStripe, type StripeElements, type StripeJs } from './stripe.ts';

/**
 * The card step after a booking (A-13). Shows the amount, what happens to it and the cancellation
 * policy before any card is entered, then mounts Stripe's Payment Element. Lazy-loaded, so the
 * Stripe script and this code reach only guests who book a service with a payment policy.
 * There is no way past it: the database keeps the booking pending until the card holds or is saved.
 * `onDone` runs after a successful confirmation, including 3-D Secure.
 */
export default function PaymentStep({
  info,
  token,
  onDone,
  returnPath = `/a/${token}`,
}: {
  info: PaymentIntentInfo;
  token: string;
  onDone: () => void;
  /** Where Stripe sends the guest back after a redirecting method (3-D Secure); the appointment page by default. */
  returnPath?: string;
}) {
  const { t, i18n } = useTranslation('booking');
  const target = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const alert = useRef<HTMLParagraphElement>(null);
  const stripe = useRef<StripeJs | null>(null);
  const elements = useRef<StripeElements | null>(null);
  const live = info.publishableKey !== '';
  const [phase, setPhase] = useState<'loading' | 'ready' | 'paying'>(live ? 'loading' : 'ready');
  const [problem, setProblem] = useState<'declined' | 'failed' | 'unavailable' | null>(null);
  const amount = formatMoney(info.amountMinor, info.currency, i18n.language);

  useEffect(() => heading.current?.focus(), []);
  useEffect(() => {
    if (problem) alert.current?.focus();
  }, [problem]);

  useEffect(() => {
    if (!live || !target.current) return;
    let cancelled = false;
    let element: ReturnType<StripeElements['create']> | undefined;
    loadStripe(info.publishableKey)
      .then((client) => {
        if (cancelled || !target.current) return;
        stripe.current = client;
        elements.current = client.elements({ clientSecret: info.clientSecret });
        element = elements.current.create('payment');
        element.mount(target.current);
        setPhase('ready');
      })
      .catch(() => {
        if (!cancelled) setProblem('unavailable');
      });
    return () => {
      cancelled = true;
      element?.destroy();
    };
  }, [live, info.publishableKey, info.clientSecret]);

  async function pay() {
    if (!stripe.current || !elements.current || phase === 'paying') return;
    setPhase('paying');
    setProblem(null);
    const args = {
      elements: elements.current,
      confirmParams: { return_url: `${window.location.origin}${returnPath}` },
      redirect: 'if_required' as const,
    };
    try {
      const { error } =
        info.kind === 'card_on_file'
          ? await stripe.current.confirmSetup(args)
          : await stripe.current.confirmPayment(args);
      if (!error) return onDone();
      setProblem(error.code === 'card_declined' ? 'declined' : 'failed');
    } catch {
      setProblem('failed');
    }
    setPhase('ready');
  }

  return (
    <Card className="flex flex-col gap-4">
      <h2 ref={heading} tabIndex={-1} className="text-2xl font-bold outline-none">
        {t(info.kind === 'pos' ? 'payment.posTitle' : 'payment.title')}
      </h2>
      <p className="text-3xl font-bold" aria-label={`${t('payment.amount')}: ${amount}`}>
        {amount}
      </p>
      <p>{t(`payment.mode.${info.kind}`, { amount })}</p>
      <p className="text-muted">
        {t(`payment.policy.${info.kind}`, { count: info.cancelCutoffHours })}
      </p>

      {live ? (
        <>
          {phase === 'loading' && !problem ? <Spinner label={t('payment.loading')} /> : null}
          <div ref={target} />
        </>
      ) : (
        <p role="note" className="text-muted">
          {t(info.kind === 'pos' ? 'payment.posTestMode' : 'payment.testMode')}
        </p>
      )}

      <p
        ref={alert}
        tabIndex={-1}
        role="alert"
        className="font-medium text-danger-strong empty:hidden"
      >
        {problem ? t(`payment.error.${problem}`) : null}
      </p>

      {live ? (
        <Button onClick={pay} disabled={phase !== 'ready' || problem === 'unavailable'}>
          {phase === 'paying' ? t('payment.paying') : t(`payment.pay.${info.kind}`, { amount })}
        </Button>
      ) : (
        <Button onClick={onDone}>
          {t(info.kind === 'pos' ? 'payment.posClose' : 'payment.continue')}
        </Button>
      )}
    </Card>
  );
}
