import { Button } from '@qm/ui';
import { useTranslation } from '../../../lib/translation.tsx';
import { authErrorCode } from '../api.ts';
import { useEnrolTotp, useVerifyTotp } from './api.ts';
import { TotpForm } from './TotpForm.tsx';

/**
 * Adds an authenticator app: shows its QR code and secret, then checks a first code. The session
 * is aal2 when `onVerified` runs.
 */
export function MfaEnrol({ onVerified }: { onVerified: () => void }) {
  const { t } = useTranslation('auth');
  const enrol = useEnrolTotp();
  const verify = useVerifyTotp();
  const failed = enrol.error ?? verify.error;
  const error = failed ? t(`errors.${authErrorCode(failed)}`) : undefined;

  if (!enrol.data) {
    return (
      <div className="flex flex-col gap-4">
        <p>{t('mfa.enrol.intro')}</p>
        <p role="alert" className="text-danger-strong font-medium empty:hidden">
          {enrol.error ? error : null}
        </p>
        <Button
          loading={enrol.isPending}
          loadingLabel={t('working')}
          onClick={() => enrol.mutate()}
        >
          {t('mfa.enrol.start')}
        </Button>
      </div>
    );
  }
  const { factorId, qrCode, secret } = enrol.data;
  return (
    <div className="flex flex-col gap-4">
      <p>{t('mfa.enrol.scan')}</p>
      <img src={qrCode} alt={t('mfa.enrol.qrAlt')} className="mx-auto size-48 bg-white p-2" />
      <p>
        {t('mfa.enrol.secret')}{' '}
        <code className="break-all font-mono" data-testid="totp-secret">
          {secret}
        </code>
      </p>
      <TotpForm
        submitLabel={t('mfa.enrol.verify')}
        pending={verify.isPending}
        error={verify.error ? error : undefined}
        onCode={(code) => verify.mutate({ factorId, code }, { onSuccess: onVerified })}
      />
    </div>
  );
}
