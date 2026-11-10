import { Button, Dialog } from '@qm/ui';
import { useState } from 'react';
import { useTranslation } from '../../lib/translation.tsx';
import { TemplatePicker, useApplyTemplate } from './templates.tsx';

/** "Apply a template" on the location settings page; the database refuses once guests have joined today. */
export function ApplyTemplate({ locationId }: { locationId: string }) {
  const { t } = useTranslation('onboarding');
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState<string | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const apply = useApplyTemplate(locationId);
  const close = () => {
    setOpen(false);
    apply.reset();
  };
  const failure = apply.error
    ? apply.error.message === 'invalid_input'
      ? t('errors.hasVisits')
      : t('errors.unknown')
    : null;
  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        {t('templates.apply')}
      </Button>
      <p role="status" className="font-medium empty:hidden">
        {apply.isSuccess && !open ? t('templates.applied') : null}
      </p>
      {open ? (
        <Dialog
          open
          onClose={close}
          title={t('templates.applyTitle')}
          description={t('templates.applyIntro')}
          footer={
            <div className="flex justify-end gap-3">
              <Button variant="secondary" onClick={close}>
                {t('templates.cancel')}
              </Button>
              <Button
                disabled={key === null}
                loading={apply.isPending}
                loadingLabel={t('working')}
                onClick={() =>
                  apply.mutate(
                    { templateKey: key!, idempotencyKey },
                    {
                      onSuccess: () => {
                        setOpen(false);
                        setKey(null);
                        setIdempotencyKey(crypto.randomUUID());
                      },
                    },
                  )
                }
              >
                {t('templates.applyConfirm')}
              </Button>
            </div>
          }
        >
          <p role="alert" className="font-medium text-danger-strong empty:hidden">
            {failure}
          </p>
          <TemplatePicker value={key} onChange={setKey} withBlank={false} />
        </Dialog>
      ) : null}
    </>
  );
}
