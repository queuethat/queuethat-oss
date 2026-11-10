import { Button, Dialog } from '@qm/ui';
import { lazy, Suspense, useState } from 'react';
import { useTranslation } from '../../../lib/translation.tsx';
import { formatMoney } from '../../admin/payments/money.ts';
import { useCreatePayCode } from './api.ts';

const TicketQr = lazy(() => import('@qm/ui/qr').then((m) => ({ default: m.TicketQr })));

/** The code as printed under the QR: two halves, easier to read out. */
const halves = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;

/**
 * "Show QR" for an unpaid counter payment (4-PAY2). The guest scans it with their own phone and
 * lands on the card form for this payment; the code opens nothing else, expires after ten minutes
 * and is replaced each time staff ask. The code is typed on /pay if a scan fails.
 */
export function PayCodeQr({
  visitId,
  amountMinor,
  currency,
}: {
  visitId: string;
  amountMinor: number;
  currency: string;
}) {
  const { t, i18n } = useTranslation('payments');
  const create = useCreatePayCode(visitId);
  const [open, setOpen] = useState(false);
  const amount = formatMoney(amountMinor, currency, i18n.language);
  const code = create.data?.code;
  return (
    <>
      <Button
        variant="secondary"
        disabled={create.isPending}
        onClick={() => {
          create.reset();
          create.mutate(undefined, { onSuccess: () => setOpen(true) });
        }}
      >
        {t('console.payCode.show')}
      </Button>
      <p role="alert" className="text-sm font-medium text-danger-strong empty:hidden">
        {create.isError ? t('console.payCode.error') : null}
      </p>
      <Dialog
        open={open && !!code}
        onClose={() => setOpen(false)}
        title={t('console.payCode.title', { amount })}
        description={t('console.payCode.description')}
        footer={<Button onClick={() => setOpen(false)}>{t('console.payCode.close')}</Button>}
      >
        {code ? (
          <Suspense fallback={null}>
            <TicketQr
              value={`${window.location.origin}/pay/${code}`}
              ticket={amount}
              code={halves(code)}
              label={t('console.payCode.label', { amount })}
            />
          </Suspense>
        ) : null}
        <p className="mt-2 text-center text-sm text-muted">{t('console.payCode.expires')}</p>
      </Dialog>
    </>
  );
}
