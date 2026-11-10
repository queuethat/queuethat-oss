import { Button, Input } from '@qm/ui';
import { useTranslation } from '../../../lib/translation.tsx';
import { TOTP_CODE_LENGTH } from './api.ts';

/** The 6-digit code from an authenticator app, and a submit button. */
export function TotpForm({
  submitLabel,
  pending,
  error,
  onCode,
}: {
  submitLabel: string;
  pending: boolean;
  error: string | undefined;
  onCode: (code: string) => void;
}) {
  const { t } = useTranslation('auth');
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        onCode(String(new FormData(event.currentTarget).get('code') ?? '').trim());
      }}
    >
      <Input
        label={t('mfa.code.label', { length: TOTP_CODE_LENGTH })}
        hint={t('mfa.code.hint')}
        error={error}
        name="code"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern={`[0-9]{${TOTP_CODE_LENGTH}}`}
        maxLength={TOTP_CODE_LENGTH}
        required
      />
      <Button type="submit" loading={pending} loadingLabel={t('working')}>
        {submitLabel}
      </Button>
    </form>
  );
}
