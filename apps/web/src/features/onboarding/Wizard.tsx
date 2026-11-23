import { Button, Card, Disclosure, Input, Stepper } from '@qm/ui';
import { useQueryClient } from '@tanstack/react-query';
import type { TFunction } from 'i18next';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from '../../lib/translation.tsx';
import {
  browserTimeZone,
  SetupError,
  timeZones,
  useSetUpBusiness,
  type BusinessSetup,
  type Created,
} from './api.ts';
import type { ProviderSetup } from './templates.tsx';
import { JoinAddressField, useJoinAddress } from './JoinAddress.tsx';
import { LineLive } from './LineLive.tsx';
import { CatalogPicker } from './catalog/CatalogPicker.tsx';
import type { CatalogEntry } from './catalog/api.ts';
import { allNamed, defaultProviders, ProviderFields } from './providers/ProviderFields.tsx';
import { clearDraft, loadDraft, saveDraft } from './draft.ts';

const STEPS = 3;

type T = TFunction<'onboarding'>;

/** "3 barbers, 6 services": what the owner just made, in their words, not table counts. */
function summarise(t: T, entry: CatalogEntry, providers: ProviderSetup | null): string {
  const services = new Set(entry.queues.flatMap((q) => q.services.map((s) => s.name))).size;
  return providers && entry.providers
    ? t('live.summaryProviders', {
        count: providers.names.length,
        noun: entry.providers.noun,
        services,
      })
    : t('live.summaryQueues', { count: entry.queues.length, services });
}

/** Three short steps from a new account to a business with a working queue (A3, #43). */
export function Wizard() {
  const { t } = useTranslation('onboarding');
  const setUp = useSetUpBusiness();
  const queryClient = useQueryClient();
  // A reload mid-wizard resumes from what was typed (O-5, #65).
  const [draft] = useState(loadDraft);
  const [step, setStep] = useState(draft?.step ?? 1);
  const [zones] = useState(timeZones);
  const [setup, setSetup] = useState<BusinessSetup>(
    () =>
      draft?.setup ?? {
        businessName: '',
        ownerName: '',
        locationName: '',
        address: '',
        timeZone: browserTimeZone(),
        queueName: t('queue.defaultName'),
        serviceName: t('queue.defaultService'),
        expectedMinutes: 10,
        templateKey: null,
      },
  );
  // The queue form under "Start blank" is closed unless the owner opens it; open means no template.
  const [blank, setBlank] = useState(draft?.blank ?? false);
  const [template, setTemplate] = useState<CatalogEntry | null>(null);
  const [created, setCreated] = useState<Created | null>(null);
  const [finished, setFinished] = useState<{ created: Created; summary: string | null } | null>(
    null,
  );
  const [unnamed, setUnnamed] = useState(false);
  useEffect(() => {
    if (!finished) saveDraft({ step, setup, blank });
  }, [finished, step, setup, blank]);
  const heading = useRef<HTMLLegendElement>(null);
  // Focus follows the step so keyboard and screen-reader users land on its heading.
  useEffect(() => {
    if (step > 1) heading.current?.focus();
  }, [step]);

  const join = useJoinAddress(setup.locationName, setup.businessName, setup.slug);

  const field = (key: Exclude<keyof BusinessSetup, 'templateKey' | 'providers' | 'slug'>) => ({
    value: String(setup[key] ?? ''),
    onChange: (event: { target: { value: string } }) =>
      setSetup((s) => ({
        ...s,
        [key]: key === 'expectedMinutes' ? Number(event.target.value) : event.target.value,
      })),
  });

  const fields = {
    businessName: field('businessName'),
    ownerName: field('ownerName'),
    locationName: field('locationName'),
    address: field('address'),
    timeZone: field('timeZone'),
    queueName: field('queueName'),
    serviceName: field('serviceName'),
    expectedMinutes: field('expectedMinutes'),
  };

  const failure =
    setUp.error instanceof SetupError ? setUp.error.code : setUp.error ? 'unknown' : null;
  const known = ['invalid_timezone', 'invalid_input', 'slug_taken', 'permission_denied'];
  const zoneInvalid = step === 2 && !zones.includes(setup.timeZone);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (zoneInvalid || (step === 2 && join.taken)) return;
    if (step < STEPS) return setStep(step + 1);
    const useTemplate = !blank && template !== null;
    const providers = useTemplate ? (setup.providers ?? null) : null;
    // Every line shown is named; whitespace does not count as a name.
    if (providers && !allNamed(providers)) return setUnnamed(true);
    setUnnamed(false);
    const final: BusinessSetup = {
      ...setup,
      // What the owner saw is what gets printed: their address, else the shown suggestion.
      slug: join.address ?? undefined,
      templateKey: useTemplate ? template.key : null,
      providers: providers && { ...providers, names: providers.names.map((n) => n.trim()) },
    };
    setUp.mutate(
      { setup: final, resume: created },
      {
        onSuccess: (done) => {
          clearDraft();
          setFinished({
            created: done,
            summary: useTemplate ? summarise(t, template, providers) : null,
          });
        },
        onError: (error) => {
          if (error instanceof SetupError) setCreated(error.created);
          // Someone took the address since it was shown: back to the step that chooses it.
          if (error instanceof SetupError && error.code === 'slug_taken') {
            setStep(2);
            void queryClient.invalidateQueries({ queryKey: ['onboarding', 'suggest-slug'] });
          }
        },
      },
    );
  };

  if (finished) return <LineLive created={finished.created} summary={finished.summary} />;

  return (
    <Card className="mx-auto mt-8 flex max-w-lg flex-col gap-4">
      <h1 className="text-2xl font-semibold">{t('title')}</h1>
      <Stepper
        label={t('steps.label')}
        steps={[t('steps.business'), t('steps.location'), t('steps.queue')]}
        current={step - 1}
      />
      <p role="alert" className="font-medium text-danger-strong empty:hidden">
        {unnamed
          ? t('errors.unnamed')
          : failure
            ? t(`errors.${known.includes(failure) ? failure : 'unknown'}` as 'errors.unknown')
            : null}
      </p>
      <form className="flex flex-col gap-4" onSubmit={submit}>
        {step === 1 ? (
          <fieldset className="flex flex-col gap-4">
            <legend ref={heading} tabIndex={-1} className="text-lg font-semibold outline-none">
              {t('business.heading')}
            </legend>
            <Input
              label={t('business.name')}
              hint={t('business.nameHint')}
              required
              maxLength={120}
              autoComplete="organization"
              {...fields.businessName}
            />
            <Input
              label={t('business.ownerName')}
              hint={t('business.ownerNameHint')}
              maxLength={80}
              autoComplete="name"
              {...fields.ownerName}
            />
          </fieldset>
        ) : null}
        {step === 2 ? (
          <fieldset className="flex flex-col gap-4">
            <legend ref={heading} tabIndex={-1} className="text-lg font-semibold outline-none">
              {t('location.heading')}
            </legend>
            <Input
              label={t('location.name')}
              hint={t('location.nameHint')}
              required
              maxLength={120}
              {...fields.locationName}
            />
            <JoinAddressField
              join={join}
              wanted={setup.slug}
              onWanted={(slug) => setSetup((s) => ({ ...s, slug }))}
            />
            <Input
              label={t('location.address')}
              hint={t('location.addressHint')}
              autoComplete="street-address"
              {...fields.address}
            />
            <Input
              label={t('location.timeZone')}
              hint={t('location.timeZoneHint')}
              list="time-zones"
              required
              error={zoneInvalid && setup.timeZone ? t('errors.invalid_timezone') : undefined}
              {...fields.timeZone}
            />
            <datalist id="time-zones">
              {zones.map((zone) => (
                <option key={zone} value={zone} />
              ))}
            </datalist>
          </fieldset>
        ) : null}
        {step === 3 ? (
          <fieldset className="flex flex-col gap-4">
            <legend ref={heading} tabIndex={-1} className="text-lg font-semibold outline-none">
              {t('queue.heading')}
            </legend>
            {/* Stays mounted while blank is open so the pick and typed names survive closing it. */}
            <div hidden={blank} className="flex flex-col gap-4">
              <CatalogPicker
                select
                chosen={null}
                initialKey={draft?.setup.templateKey ?? null}
                hint={setup.businessName}
                busy={setUp.isPending}
                onUse={(entry) => {
                  setTemplate(entry);
                  // No match leaves the last pick alone; a restored draft keeps its typed names.
                  if (entry)
                    setSetup((s) =>
                      s.templateKey === entry.key
                        ? s
                        : {
                            ...s,
                            templateKey: entry.key,
                            providers: entry.providers ? defaultProviders(entry.providers) : null,
                          },
                    );
                }}
              />
              {!blank && template?.providers && setup.providers ? (
                <ProviderFields
                  noun={template.providers.noun}
                  value={setup.providers}
                  onChange={(providers) => setSetup((s) => ({ ...s, providers }))}
                />
              ) : null}
            </div>
            <Disclosure title={t('catalog.startBlank')} open={blank} onOpenChange={setBlank}>
              <p>{t('queue.intro')}</p>
              <Input label={t('queue.name')} required maxLength={80} {...fields.queueName} />
              <Input label={t('queue.service')} required maxLength={80} {...fields.serviceName} />
              <Input
                label={t('queue.minutes')}
                type="number"
                inputMode="numeric"
                min={1}
                max={600}
                required
                {...fields.expectedMinutes}
              />
            </Disclosure>
          </fieldset>
        ) : null}
        <div className="flex justify-between gap-4">
          {step > 1 ? (
            <Button
              variant="secondary"
              onClick={() => setStep(step - 1)}
              disabled={setUp.isPending}
            >
              {t('back')}
            </Button>
          ) : (
            <span />
          )}
          <Button type="submit" loading={setUp.isPending} loadingLabel={t('working')}>
            {step < STEPS ? t('next') : t('finish')}
          </Button>
        </div>
      </form>
    </Card>
  );
}
