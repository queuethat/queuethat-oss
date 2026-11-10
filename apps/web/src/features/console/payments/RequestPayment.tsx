import { Button, Input, Select } from '@qm/ui';
import { useState, type FormEvent } from 'react';
import { useTranslation } from '../../../lib/translation.tsx';
import { CURRENCIES, toMinor } from '../../admin/payments/money.ts';
import { useRequestPayment } from './api.ts';

/**
 * Staff ask the guest to pay an amount at the counter (4-PAY1). The guest's own phone shows the
 * request on their status page; asking again corrects the amount until they have opened it.
 */
export function RequestPayment({ visitId }: { visitId: string }) {
  const { t } = useTranslation('payments');
  const request = useRequestPayment(visitId);
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState<string>(CURRENCIES[0]);
  const [invalid, setInvalid] = useState(false);

  function submit(e: FormEvent) {
    e.preventDefault();
    const minor = toMinor(amount);
    setInvalid(minor === null);
    if (minor !== null) request.mutate({ amountMinor: minor, currency });
  }

  return (
    <form className="flex flex-col gap-2" onSubmit={submit} noValidate>
      <div className="flex flex-wrap items-end gap-2">
        <Input
          label={t('console.request.amount')}
          inputMode="decimal"
          value={amount}
          error={invalid ? t('console.request.invalid') : undefined}
          onChange={(e) => setAmount(e.target.value)}
        />
        <Select
          label={t('console.request.currency')}
          value={currency}
          onChange={(e) => setCurrency(e.target.value)}
        >
          {CURRENCIES.map((c) => (
            <option key={c} value={c}>
              {c.toUpperCase()}
            </option>
          ))}
        </Select>
        <Button type="submit" disabled={request.isPending}>
          {t('console.request.submit')}
        </Button>
      </div>
      <p role="alert" className="text-sm font-medium text-danger-strong empty:hidden">
        {request.isError ? t('console.request.error') : null}
      </p>
      <p role="status" className="text-sm text-muted empty:hidden">
        {request.isSuccess ? t('console.request.sent') : null}
      </p>
    </form>
  );
}
