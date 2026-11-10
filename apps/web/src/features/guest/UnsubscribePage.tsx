import { errorCode } from '@qm/domain';
import { BigButton, Card, EmptyState } from '@qm/ui';
import { useTranslation } from '../../lib/translation.tsx';
import { useUnsubscribe } from './api.ts';

/**
 * `/u?n=&t=`: the "Stop these emails" link in a guest email. Opening it changes nothing (mail
 * scanners follow links); the button does. Mail clients that support RFC 8058 skip this page and
 * POST the List-Unsubscribe header straight to the unsubscribe function.
 */
export function UnsubscribePage({ n, t: token }: { n: string; t: string }) {
  const { t } = useTranslation('guest');
  const unsubscribe = useUnsubscribe();

  if (!n || !token || errorCode(unsubscribe.error) === 'invalid_input') {
    return (
      <EmptyState
        title={t('unsubscribe.invalid.title')}
        description={t('unsubscribe.invalid.body')}
      />
    );
  }
  if (unsubscribe.isSuccess) {
    return (
      <EmptyState title={t('unsubscribe.done.title')} description={t('unsubscribe.done.body')} />
    );
  }
  return (
    <Card className="my-4 flex flex-col gap-5">
      <h1 className="text-xl font-semibold">{t('unsubscribe.title')}</h1>
      <p>{t('unsubscribe.body')}</p>
      {unsubscribe.isError ? (
        <p role="alert" className="font-medium text-danger-strong">
          {t('unsubscribe.failed')}
        </p>
      ) : null}
      <BigButton
        loading={unsubscribe.isPending}
        onClick={() => unsubscribe.mutate({ n, t: token })}
      >
        {t('unsubscribe.confirm')}
      </BigButton>
    </Card>
  );
}
