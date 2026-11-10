import { Button } from '@qm/ui';
import { useTranslation } from '../../lib/translation.tsx';
import { appConfig } from '../../lib/config.ts';
import { useTelegramLink } from './api.ts';

/**
 * "Get updates on Telegram" on the status page (N-3, #253). Rendered only when the deployment has a
 * bot (`TELEGRAM_BOT`). Telegram works in an iPhone's browser without a Home Screen install. The
 * link is completed by the bot's webhook, so the page says what to do there rather than claim it is
 * linked.
 */
export function TelegramOptIn({ token }: { token: string }) {
  const { t } = useTranslation('guest');
  const link = useTelegramLink(token);
  if (!appConfig().telegramBot) return null;
  if (link.isSuccess) {
    return (
      <p role="status" className="text-center text-sm text-muted">
        {t('status.telegram.opened')}
      </p>
    );
  }
  const failure = link.error
    ? link.error.message === 'invalid_input'
      ? 'unavailable'
      : 'failed'
    : null;
  return (
    <div className="flex flex-col gap-2">
      <Button
        variant="secondary"
        className="min-h-target-big w-full"
        loading={link.isPending}
        loadingLabel={t('status.telegram.opening')}
        onClick={() =>
          link.mutate(undefined, {
            onSuccess: (deepLink) => window.open(deepLink, '_blank', 'noopener'),
          })
        }
      >
        {t('status.telegram.enable')}
      </Button>
      {failure ? (
        <p role="alert" className="text-sm font-medium text-danger-strong">
          {t(`status.telegram.${failure}`)}
        </p>
      ) : null}
    </div>
  );
}
