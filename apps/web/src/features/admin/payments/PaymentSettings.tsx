import { Button, Card, Input, Select, Spinner } from '@qm/ui';
import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from '../../../lib/translation.tsx';
import {
  paymentPolicyQuery,
  useSavePaymentPolicy,
  type PaymentMode,
  type PaymentPolicy,
  type ReleaseAfter,
} from './api.ts';
import { CURRENCIES, fromMinor, toMinor } from './money.ts';

interface Props {
  service: { id: string; name: string };
  org: { orgId: string; locationId: string };
  canManage: boolean;
  onClose: () => void;
}

/** The Payments panel of a service: whether booking asks for a deposit or a card hold (A-13). */
export function PaymentSettings({ service, org, canManage, onClose }: Props) {
  const { t } = useTranslation('payments');
  const policy = useQuery(paymentPolicyQuery(service.id));
  if (!policy.data) return <Spinner label={t('admin.loading')} />;
  return (
    <Card className="flex flex-col gap-4" data-testid="payment-settings">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">{t('admin.title', { service: service.name })}</h2>
        <Button variant="secondary" onClick={onClose}>
          {t('admin.close')}
        </Button>
      </div>
      {canManage ? null : <p className="text-muted">{t('admin.readOnly')}</p>}
      <PolicyForm
        initial={policy.data}
        target={{ ...org, serviceId: service.id }}
        canManage={canManage}
      />
    </Card>
  );
}

function PolicyForm({
  initial,
  target,
  canManage,
}: {
  initial: PaymentPolicy;
  target: { orgId: string; locationId: string; serviceId: string };
  canManage: boolean;
}) {
  const { t } = useTranslation('payments');
  const save = useSavePaymentPolicy(target);
  const [mode, setMode] = useState<PaymentMode>(initial.mode);
  const [amount, setAmount] = useState(
    initial.amountMinor > 0 ? fromMinor(initial.amountMinor) : '',
  );
  const [currency, setCurrency] = useState(initial.currency);
  const [releaseAfter, setReleaseAfter] = useState<ReleaseAfter>(initial.releaseAfter);
  const [cutoff, setCutoff] = useState(String(initial.cancelCutoffHours));
  const [shown, setShown] = useState(false);
  const minor = toMinor(amount);
  const cutoffHours = Number(cutoff);
  const errors = {
    amount: mode !== 'none' && minor === null,
    cutoff: !Number.isInteger(cutoffHours) || cutoffHours < 0 || cutoffHours > 720,
  };

  function submit(event: FormEvent) {
    event.preventDefault();
    setShown(true);
    if (errors.amount || errors.cutoff) return;
    save.mutate({
      mode,
      amountMinor: minor ?? 0,
      currency,
      releaseAfter,
      cancelCutoffHours: cutoffHours,
    });
  }
  const failure = save.error
    ? save.error.message.includes('permission') || save.error.message.includes('row-level')
      ? 'permission_denied'
      : save.error.message.includes('payments_not_connected')
        ? 'payments_not_connected'
        : 'unknown'
    : null;
  return (
    <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <Select
        label={t('admin.mode')}
        value={mode}
        disabled={!canManage}
        onChange={(e) => setMode(e.target.value as PaymentMode)}
      >
        <option value="none">{t('admin.modes.none')}</option>
        <option value="deposit">{t('admin.modes.deposit')}</option>
        <option value="hold">{t('admin.modes.hold')}</option>
      </Select>
      <p className="text-sm text-muted">{t(`admin.modeHint.${mode}`)}</p>
      {mode === 'none' ? null : (
        <>
          <Input
            label={t('admin.amount')}
            inputMode="decimal"
            readOnly={!canManage}
            value={amount}
            error={shown && errors.amount ? t('admin.invalid.amount') : undefined}
            onChange={(e) => setAmount(e.target.value)}
          />
          <Select
            label={t('admin.currency')}
            value={currency}
            disabled={!canManage}
            onChange={(e) => setCurrency(e.target.value)}
          >
            {CURRENCIES.map((c) => (
              <option key={c} value={c}>
                {c.toUpperCase()}
              </option>
            ))}
          </Select>
          <Input
            label={t('admin.cutoff')}
            hint={t('admin.cutoffHint')}
            type="number"
            inputMode="numeric"
            min={0}
            max={720}
            readOnly={!canManage}
            value={cutoff}
            error={shown && errors.cutoff ? t('admin.invalid.cutoff') : undefined}
            onChange={(e) => setCutoff(e.target.value)}
          />
          {mode === 'hold' ? (
            <Select
              label={t('admin.releaseAfter')}
              value={releaseAfter}
              disabled={!canManage}
              onChange={(e) => setReleaseAfter(e.target.value as ReleaseAfter)}
            >
              <option value="served">{t('admin.release.served')}</option>
              <option value="checked_in">{t('admin.release.checked_in')}</option>
            </Select>
          ) : null}
        </>
      )}
      <p role="alert" className="font-medium text-danger-strong empty:hidden">
        {failure ? t(`admin.errors.${failure}`) : null}
      </p>
      <p role="status" className="empty:hidden">
        {save.isSuccess ? t('admin.saved') : null}
      </p>
      {canManage ? (
        <Button type="submit" loading={save.isPending} loadingLabel={t('admin.saving')}>
          {t('admin.save')}
        </Button>
      ) : null}
    </form>
  );
}
