import { Button, Card, Input, Stepper } from '@qm/ui';
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
import { LineLive } from './LineLive.tsx';
import { CatalogPicker } from './catalog/CatalogPicker.tsx';
import type { CatalogEntry } from './catalog/api.ts';
import { defaultProviders, ProviderFields } from './providers/ProviderFields.tsx';

const STEPS = 3;

/** Three short steps from a new account to a business with a working queue (A3, #43). */
export function Wizard() {
  const { t } = useTranslation('onboarding');
  const setUp = useSetUpBusiness();
  const [step, setStep] = useState(1);
  const [zones] = useState(timeZones);
  const [setup, setSetup] = useState<BusinessSetup>(() => ({
    businessName: '',
    locationName: '',
    address: '',
    timeZone: browserTimeZone(),
    queueName: t('queue.defaultName'),
    serviceName: t('queue.defaultService'),
    expectedMinutes: 10,
    templateKey: null,
  }));
  const [template, setTemplate] = useState<CatalogEntry | null>(null);
  const [created, setCreated] = useState<Created | null>(null);
  const [finished, setFinished] = useState<Created | null>(null);
  const heading = useRef<HTMLLegendElement>(null);
  // Focus follows the step so keyboard and screen-reader users land on its heading.
  useEffect(() => {
    if (step > 1) heading.current?.focus();
  }, [step]);

  const field = (key: Exclude<keyof BusinessSetup, 'templateKey'>) => ({
    value: String(setup[key]),
    onChange: (event: { target: { value: string } }) =>
      setSetup((s) => ({
        ...s,
        [key]: key === 'expectedMinutes' ? Number(event.target.value) : event.target.value,
      })),
  });

  const fields = {
    businessName: field('businessName'),
    locationName: field('locationName'),
    address: field('address'),
    timeZone: field('timeZone'),
    queueName: field('queueName'),
    serviceName: field('serviceName'),
    expectedMinutes: field('expectedMinutes'),
  };

  const failure =
    setUp.error instanceof SetupError ? setUp.error.code : setUp.error ? 'unknown' : null;
  const known = ['invalid_timezone', 'invalid_input', 'permission_denied'];
  const zoneInvalid = step === 2 && !zones.includes(setup.timeZone);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (zoneInvalid) return;
    if (step < STEPS) return setStep(step + 1);
    setUp.mutate(
      { setup, resume: created },
      {
        onSuccess: (done) => setFinished(done),
        onError: (error) => {
          if (error instanceof SetupError) setCreated(error.created);
        },
      },
    );
  };

  if (finished) return <LineLive created={finished} />;

  return (
    <Card className="mx-auto mt-8 flex max-w-lg flex-col gap-4">
      <h1 className="text-2xl font-semibold">{t('title')}</h1>
      <Stepper
        label={t('steps.label')}
        steps={[t('steps.business'), t('steps.location'), t('steps.queue')]}
        current={step - 1}
      />
      <p role="alert" className="font-medium text-danger-strong empty:hidden">
        {failure
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
            <CatalogPicker
              chosen={template}
              hint={setup.businessName}
              busy={setUp.isPending}
              onUse={(entry) => {
                setTemplate(entry);
                setSetup((s) => ({
                  ...s,
                  templateKey: entry?.key ?? null,
                  providers: entry?.providers ? defaultProviders(entry.providers, t) : null,
                }));
              }}
            />
            {template?.providers && setup.providers ? (
              <ProviderFields
                noun={template.providers.noun}
                value={setup.providers}
                onChange={(providers) => setSetup((s) => ({ ...s, providers }))}
              />
            ) : null}
            {setup.templateKey ? null : (
              <>
                <p>
                  {t('catalog.orBlank')} {t('queue.intro')}
                </p>
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
              </>
            )}
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
