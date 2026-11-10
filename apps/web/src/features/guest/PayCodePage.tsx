import { Card, Spinner } from '@qm/ui';
import { useQuery } from '@tanstack/react-query';
import { lazy, Suspense, useState } from 'react';
import { useTranslation } from '../../lib/translation.tsx';
import { requestPosPaymentByCode } from '../booking/payment/api.ts';

// The Stripe script and the card form load only for a guest who scanned a staff pay code.
const PaymentStep = lazy(() => import('../booking/payment/PaymentStep.tsx'));

/**
 * The page a staff tablet's QR opens (4-PAY2): the amount staff asked for and the same Payment
 * Element as the status page's "Pay now". It holds only the pay code, never a link token, and
 * shows one neutral message whether the code is unknown, expired, replaced or already paid.
 */
export function PayCodePage({ code }: { code: string }) {
  const { t } = useTranslation('booking');
  // Stripe sends the guest back here after 3-D Secure with redirect_status. By then the payment is
  // paid and the code is dead, so the lookup would say "ended"; thank the guest instead. This is only
  // the message: whether it was paid is the webhook's call, and the code reveals nothing either way.
  const [paid, setPaid] = useState(
    () => new URLSearchParams(window.location.search).get('redirect_status') === 'succeeded',
  );
  const request = useQuery({
    queryKey: ['pos-payment-code', code],
    queryFn: () => requestPosPaymentByCode(code),
    enabled: !paid,
    retry: false,
    // A refetch on focus would create nothing new (the intent is idempotent) but is noise.
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  });
  if (paid) {
    return (
      <Card>
        <p role="status" className="font-medium">
          {t('payCode.paid')}
        </p>
      </Card>
    );
  }
  if (request.isPending) return <Spinner label={t('payment.loading')} />;
  if (!request.data) {
    return (
      <Card className="flex flex-col gap-2">
        <h1 className="text-2xl font-bold">{t('payCode.endedTitle')}</h1>
        <p role={request.isError ? 'alert' : undefined}>
          {t(request.isError ? 'payCode.unavailable' : 'payCode.ended')}
        </p>
      </Card>
    );
  }
  return (
    <Suspense fallback={<Spinner label={t('payment.loading')} />}>
      <PaymentStep
        info={request.data}
        token={code}
        returnPath={`/pay/${code}`}
        onDone={() => setPaid(true)}
      />
    </Suspense>
  );
}
