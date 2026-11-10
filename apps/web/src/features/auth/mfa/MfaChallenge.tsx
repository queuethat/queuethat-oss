import { useTranslation } from '../../../lib/translation.tsx';
import { authErrorCode } from '../api.ts';
import { useVerifyTotp } from './api.ts';
import { TotpForm } from './TotpForm.tsx';

/** Asks for a code from the account's authenticator app; the session is aal2 on `onVerified`. */
export function MfaChallenge({
  factorId,
  onVerified,
}: {
  factorId: string;
  onVerified: () => void;
}) {
  const { t } = useTranslation('auth');
  const verify = useVerifyTotp();
  return (
    <TotpForm
      submitLabel={t('mfa.challenge.submit')}
      pending={verify.isPending}
      error={verify.error ? t(`errors.${authErrorCode(verify.error)}`) : undefined}
      onCode={(code) => verify.mutate({ factorId, code }, { onSuccess: onVerified })}
    />
  );
}
