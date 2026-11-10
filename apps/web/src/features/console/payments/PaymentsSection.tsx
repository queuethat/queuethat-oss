import { Badge, ConfirmDestructive, Input } from '@qm/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from '../../../lib/translation.tsx';
import { canManageQueues } from '../../admin/queues/api.ts';
import { formatMoney, fromMinor, toMinor } from '../../admin/payments/money.ts';
import { useCurrentOrg } from '../../auth/current.ts';
import {
  badgeOf,
  useChargeNoShow,
  useRefundPayment,
  visitPaymentsQuery,
  type PaymentBadge,
  type VisitPayment,
} from './api.ts';
import { PayCodeQr } from './PayCodeQr.tsx';
import { RequestPayment } from './RequestPayment.tsx';

const TONE: Record<PaymentBadge, 'neutral' | 'info' | 'success' | 'warning' | 'danger'> = {
  requires_action: 'neutral',
  held: 'info',
  paid: 'success',
  card_on_file: 'info',
  released: 'neutral',
  refunded: 'neutral',
  failed: 'danger',
};

/**
 * Payment status of a visit with the manager-only actions (A-13): charge a no-show fee on a held or
 * saved card, refund a paid one. Money moves only after the confirm tap, and there is no undo.
 */
export function PaymentsSection({
  visitId,
  visitStatus,
}: {
  visitId: string;
  visitStatus: string;
}) {
  const { t } = useTranslation('payments');
  const payments = useQuery(visitPaymentsQuery(visitId));
  const canAct = canManageQueues(useCurrentOrg()?.role);
  // Anyone with a role at the location may ask for a payment while the guest is with them.
  const canRequest = ['called', 'serving', 'served'].includes(visitStatus);
  if (!payments.data || (!payments.data.length && !canRequest)) return null;
  return (
    <section
      className="flex flex-col gap-2"
      aria-labelledby="visit-payments-title"
      data-testid="visit-payments"
    >
      <h3 id="visit-payments-title" className="font-medium">
        {t('console.title')}
      </h3>
      <ul className="flex flex-col gap-3">
        {payments.data.map((p) => (
          <PaymentRow
            key={p.id}
            payment={p}
            visitId={visitId}
            canCharge={canAct && visitStatus === 'no_show'}
            canRefund={canAct}
          />
        ))}
      </ul>
      {canRequest ? <RequestPayment visitId={visitId} /> : null}
    </section>
  );
}

function PaymentRow({
  payment: p,
  visitId,
  canCharge,
  canRefund,
}: {
  payment: VisitPayment;
  visitId: string;
  canCharge: boolean;
  canRefund: boolean;
}) {
  const { t, i18n } = useTranslation('payments');
  const charge = useChargeNoShow(visitId);
  const refund = useRefundPayment(visitId);
  const money = (minor: number) => formatMoney(minor, p.currency, i18n.language);
  const badge = badgeOf(p);
  const left = p.amountMinor - p.refundedMinor;
  const chargeable =
    canCharge && p.status === 'authorized' && (p.kind === 'hold' || p.kind === 'card_on_file');
  const refundable = canRefund && (p.status === 'succeeded' || p.status === 'captured') && left > 0;
  return (
    <li className="flex flex-col gap-2" data-testid="visit-payment">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={TONE[badge]}>{t(`console.badge.${badge}`)}</Badge>
        <span>
          {t(`console.kind.${p.kind}`)} · {money(p.amountMinor)}
        </span>
        {p.refundedMinor > 0 ? (
          <span className="text-sm text-muted">
            {t('console.refunded', { amount: money(p.refundedMinor) })}
          </span>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-2">
        {chargeable ? (
          <ConfirmDestructive
            triggerLabel={t('console.charge.trigger')}
            title={t('console.charge.title', { amount: money(p.amountMinor) })}
            description={t('console.charge.description', { amount: money(p.amountMinor) })}
            confirmLabel={t('console.charge.confirm', { amount: money(p.amountMinor) })}
            cancelLabel={t('console.charge.cancel')}
            onConfirm={() => charge.mutateAsync(p.id)}
          />
        ) : null}
        {p.kind === 'pos' && p.status === 'requires_action' ? (
          <PayCodeQr visitId={visitId} amountMinor={p.amountMinor} currency={p.currency} />
        ) : null}
        {refundable ? (
          <RefundButton
            payment={p}
            left={left}
            money={money}
            onRefund={(amountMinor, reason) =>
              refund.mutateAsync({ paymentId: p.id, amountMinor, reason })
            }
          />
        ) : null}
      </div>
      <p role="alert" className="text-sm font-medium text-danger-strong empty:hidden">
        {charge.isError || refund.isError ? t('console.error') : null}
      </p>
      <p role="status" className="text-sm text-muted empty:hidden">
        {charge.isSuccess || refund.isSuccess ? t('console.queued') : null}
      </p>
    </li>
  );
}

function RefundButton({
  payment,
  left,
  money,
  onRefund,
}: {
  payment: VisitPayment;
  left: number;
  money: (minor: number) => string;
  onRefund: (amountMinor: number, reason: string) => Promise<unknown>;
}) {
  const { t } = useTranslation('payments');
  const [amount, setAmount] = useState(fromMinor(left));
  const [reason, setReason] = useState('');
  const minor = toMinor(amount);
  const valid = minor !== null && minor <= left;
  return (
    <ConfirmDestructive
      triggerLabel={t('console.refund.trigger')}
      triggerVariant="secondary"
      title={t('console.refund.title')}
      description={t('console.refund.description', { amount: money(left) })}
      confirmLabel={t('console.refund.confirm', { amount: money(valid ? minor : 0) })}
      cancelLabel={t('console.refund.cancel')}
      confirmDisabled={!valid}
      onConfirm={() => onRefund(minor ?? 0, reason.trim())}
    >
      <div className="flex flex-col gap-3" data-payment={payment.id}>
        <Input
          label={t('console.refund.amount')}
          inputMode="decimal"
          value={amount}
          error={valid ? undefined : t('console.refund.invalid', { max: money(left) })}
          onChange={(e) => setAmount(e.target.value)}
        />
        <Input
          label={t('console.refund.reason')}
          value={reason}
          maxLength={200}
          onChange={(e) => setReason(e.target.value)}
        />
      </div>
    </ConfirmDestructive>
  );
}
