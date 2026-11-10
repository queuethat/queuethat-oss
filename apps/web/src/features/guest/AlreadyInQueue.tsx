import { Button, Card, ConfirmDestructive } from '@qm/ui';
import { useNavigate } from '@tanstack/react-router';
import { useTranslation } from '../../lib/translation.tsx';
import { forgetVisit, savedVisitScopes, useActiveVisit, useLeaveQueue } from './api.ts';

/**
 * Shown when the database refused a join with `already_in_queue` (J-16). `detail` names the other
 * queue when this phone holds that visit, else it is `contact` and the name stays private. If this
 * phone still has the link, the guest can open that ticket or leave it and join here.
 */
export default function AlreadyInQueue({
  detail,
  onLeft,
}: {
  detail: string | null;
  onLeft: () => void;
}) {
  const { t } = useTranslation('guest');
  const navigate = useNavigate();
  const token = useActiveVisit(savedVisitScopes()).data ?? null;
  const leave = useLeaveQueue(token ?? '');
  const queue = detail && detail !== 'contact' ? detail : null;
  return (
    <Card role="alert" className="flex flex-col gap-3 bg-warning-soft text-warning-strong">
      <p className="font-medium">
        {queue ? t('join.already.named', { queue }) : t('join.already.generic')}
      </p>
      {token ? (
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => void navigate({ to: '/v/$token', params: { token } })}>
            {t('join.already.open')}
          </Button>
          <ConfirmDestructive
            triggerLabel={t('join.already.leave')}
            triggerVariant="secondary"
            title={t('join.already.leaveTitle')}
            description={t('join.already.leaveBody')}
            confirmLabel={t('join.already.leaveConfirm')}
            cancelLabel={t('join.already.leaveCancel')}
            onConfirm={() =>
              leave.mutateAsync().then(() => {
                forgetVisit(token);
                onLeft();
              })
            }
          />
        </div>
      ) : (
        <p>{t('join.already.ask')}</p>
      )}
    </Card>
  );
}
