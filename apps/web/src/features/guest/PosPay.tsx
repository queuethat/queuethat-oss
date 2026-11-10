import { Card } from '@qm/ui';
import { useQuery } from '@tanstack/react-query';
import { lazy, Suspense, useState } from 'react';
import { useTranslation } from '../../lib/translation.tsx';
import { requestPosPayment } from '../booking/payment/api.ts';

// The Stripe script and the card form load only for a guest staff actually asked to pay.
const PaymentStep = lazy(() => import('../booking/payment/PaymentStep.tsx'));

/**
 * "Pay now" on the status page (4-PAY1): shows what staff asked this guest to pay at the counter and
 * mounts the same Payment Element as the booking card step. Renders nothing while no request is open;
 * it looks again every few seconds so a request made while the page is open appears by itself.
 */
export function PosPay({ token }: { token: string }) {
  const { t } = useTranslation('guest');
  const [paid, setPaid] = useState(false);
  const request = useQuery({
    queryKey: ['pos-payment', token],
    queryFn: () => requestPosPayment(token),
    enabled: !paid,
    refetchInterval: 15_000,
    retry: false,
  });
  if (paid) {
    return (
      <Card>
        <p role="status" className="font-medium">
          {t('status.pos.paid')}
        </p>
      </Card>
    );
  }
  if (!request.data) return null;
  return (
    <Suspense fallback={null}>
      <PaymentStep
        info={request.data}
        token={token}
        returnPath={`/v/${token}`}
        onDone={() => setPaid(true)}
      />
    </Suspense>
  );
}
