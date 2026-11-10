import { BigButton } from '@qm/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from '../../lib/translation.tsx';
import { useUndoLeave } from './api.ts';

/**
 * "Left by mistake?" (#528): shown only while the database offers `undo_leave` in `guest_actions`
 * (a few minutes after the guest's own leave). One tap puts them back at their old place.
 */
export function UndoLeave({ token }: { token: string }) {
  const { t } = useTranslation('guest');
  const undo = useUndoLeave(token);
  const queryClient = useQueryClient();
  return (
    <div className="flex flex-col gap-2 text-center">
      <p className="text-muted">{t('status.undoLeave.prompt')}</p>
      <BigButton
        variant="secondary"
        disabled={undo.isPending}
        onClick={() =>
          undo.mutate(undefined, {
            // The window closed or staff acted since: show what the database says now.
            onError: () =>
              void queryClient.invalidateQueries({ queryKey: ['guest', 'visit', token] }),
          })
        }
      >
        {t('status.undoLeave.action')}
      </BigButton>
      {undo.isError ? (
        <p role="alert" className="font-medium text-danger-strong">
          {t('status.undoLeave.failed')}
        </p>
      ) : null}
    </div>
  );
}
