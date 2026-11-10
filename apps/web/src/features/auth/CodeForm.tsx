import { Button, Input } from '@qm/ui';
import { useNavigate } from '@tanstack/react-router';
import { useTranslation } from '../../lib/translation.tsx';
import { authErrorCode, SIGN_IN_CODE_LENGTH, useVerifyCode } from './api.ts';

/**
 * The code from a sign-in, confirmation or recovery email, for when the emailed link opens on
 * another device or browser. Signs in and goes to `next`.
 */
export function CodeForm({
  email,
  type,
  next,
}: {
  email: string;
  type: 'email' | 'signup' | 'recovery';
  next: string;
}) {
  const { t } = useTranslation('auth');
  const navigate = useNavigate();
  const verify = useVerifyCode();
  const error = verify.error ? t(`errors.${authErrorCode(verify.error)}`) : undefined;
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        const code = String(new FormData(event.currentTarget).get('code') ?? '').trim();
        verify.mutate({ email, code, type }, { onSuccess: () => void navigate({ to: next }) });
      }}
    >
      <Input
        label={t('code.label', { length: SIGN_IN_CODE_LENGTH })}
        hint={t('code.hint')}
        error={error}
        name="code"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern={`[0-9]{${SIGN_IN_CODE_LENGTH}}`}
        maxLength={SIGN_IN_CODE_LENGTH}
        required
      />
      <Button type="submit" loading={verify.isPending} loadingLabel={t('working')}>
        {t('code.submit')}
      </Button>
    </form>
  );
}
