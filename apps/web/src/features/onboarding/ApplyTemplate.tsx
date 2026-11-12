import { Button, Dialog } from '@qm/ui';
import { useState } from 'react';
import { useTranslation } from '../../lib/translation.tsx';
import type { CatalogEntry } from './catalog/api.ts';
import { CatalogPicker } from './catalog/CatalogPicker.tsx';
import { defaultProviders, ProviderFields } from './providers/ProviderFields.tsx';
import { useApplyTemplate, type ProviderSetup } from './templates.tsx';

/**
 * "Apply a template" on the location settings page: "Use this" copies the template into the
 * location; a template for several providers first asks how many and their names. The database
 * refuses once guests have joined today.
 */
export function ApplyTemplate({ locationId }: { locationId: string }) {
  const { t } = useTranslation('onboarding');
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<CatalogEntry | null>(null);
  const [providers, setProviders] = useState<ProviderSetup | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const apply = useApplyTemplate(locationId);
  const close = () => {
    setOpen(false);
    setChosen(null);
    apply.reset();
  };
  const run = (templateKey: string, setup: ProviderSetup | null) =>
    apply.mutate(
      { templateKey, idempotencyKey, providers: setup },
      {
        onSuccess: () => {
          setOpen(false);
          setChosen(null);
          setIdempotencyKey(crypto.randomUUID());
        },
      },
    );
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
              {chosen && providers ? (
                <Button
                  loading={apply.isPending}
                  loadingLabel={t('working')}
                  disabled={providers.names.some((n) => !n.trim())}
                  onClick={() => run(chosen.key, providers)}
                >
                  {t('providers.apply', { count: providers.names.length })}
                </Button>
              ) : null}
            </div>
          }
        >
          <p role="alert" className="font-medium text-danger-strong empty:hidden">
            {failure}
          </p>
          <CatalogPicker
            chosen={chosen}
            busy={apply.isPending}
            onUse={(entry) => {
              if (entry?.providers) {
                setChosen(entry);
                setProviders(defaultProviders(entry.providers, t));
              } else if (entry) run(entry.key, null);
              else setChosen(null);
            }}
          />
          {chosen?.providers && providers ? (
            <ProviderFields
              noun={chosen.providers.noun}
              value={providers}
              onChange={setProviders}
            />
          ) : null}
        </Dialog>
      ) : null}
    </>
  );
}
