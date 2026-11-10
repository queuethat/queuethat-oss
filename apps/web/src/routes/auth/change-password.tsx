import { Button, Input } from '@qm/ui';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useTranslation } from '../../lib/translation.tsx';
import { authErrorCode, useChangePassword } from '../../features/auth/api.ts';
import { useAuthCaptcha } from '../../features/auth/AuthCaptcha.tsx';
import { AuthCard } from '../../features/auth/AuthForm.tsx';

// A signed-in user changes their password: the current one is required (see useChangePassword).
export const Route = createFileRoute('/auth/change-password')({
  beforeLoad: async (args) => {
    const { requireSession } = await import('../../features/auth/guard.ts');
    await requireSession(args);
  },
  component: ChangePasswordPage,
});

function ChangePasswordPage() {
  const { t } = useTranslation('auth');
  const change = useChangePassword();
  const captcha = useAuthCaptcha();
  return (
    <AuthCard
      title={t('change.title')}
      error={change.error ? t(`errors.${authErrorCode(change.error)}`) : undefined}
      footer={
        <Link to="/staff" className="inline-flex min-h-target items-center font-medium underline">
          {t('change.back')}
        </Link>
      }
    >
      {change.isSuccess ? (
        <p role="status">{t('change.done')}</p>
      ) : (
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            change.mutate(
              {
                currentPassword: String(data.get('current') ?? ''),
                newPassword: String(data.get('password') ?? ''),
                captchaToken: captcha.token,
              },
              { onSettled: captcha.refresh },
            );
          }}
        >
          <Input
            label={t('change.current')}
            name="current"
            type="password"
            autoComplete="current-password"
            required
          />
          <Input
            label={t('change.new')}
            hint={t('change.hint')}
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={8}
            required
          />
          {captcha.widget}
          <Button
            type="submit"
            loading={change.isPending}
            loadingLabel={t('working')}
            disabled={!captcha.ready}
          >
            {t('change.submit')}
          </Button>
          <Link
            to="/auth/forgot-password"
            className="inline-flex min-h-target items-center text-sm font-medium underline"
          >
            {t('change.noPassword')}
          </Link>
        </form>
      )}
    </AuthCard>
  );
}
