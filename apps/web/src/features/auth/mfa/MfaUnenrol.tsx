import { ConfirmDestructive, Input } from '@qm/ui';
import { useState } from 'react';
import { useTranslation } from '../../../lib/translation.tsx';
import { authErrorCode } from '../api.ts';
import { TOTP_CODE_LENGTH, useUnenrolTotp } from './api.ts';

/** Removes the authenticator app, after a fresh code from it and an explicit confirm (I-9). */
export function MfaUnenrol({ factorId }: { factorId: string }) {
  const { t } = useTranslation('auth');
  const unenrol = useUnenrolTotp();
  const [code, setCode] = useState('');
  return (
    <div className="flex flex-col gap-4">
      <Input
        label={t('mfa.unenrol.code', { length: TOTP_CODE_LENGTH })}
        error={unenrol.error ? t(`errors.${authErrorCode(unenrol.error)}`) : undefined}
        name="code"
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={TOTP_CODE_LENGTH}
        value={code}
        onChange={(event) => setCode(event.target.value.trim())}
      />
      <ConfirmDestructive
        triggerLabel={t('mfa.unenrol.trigger')}
        title={t('mfa.unenrol.title')}
        description={t('mfa.unenrol.description')}
        confirmLabel={t('mfa.unenrol.confirm')}
        cancelLabel={t('mfa.unenrol.cancel')}
        disabled={code.length !== TOTP_CODE_LENGTH}
        onConfirm={() => unenrol.mutateAsync({ factorId, code }).catch(() => {})}
      />
    </div>
  );
}
