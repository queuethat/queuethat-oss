import { errorCode } from '@qm/domain';
import {
  BigButton,
  Button,
  Card,
  ConnectionIndicator,
  Dialog,
  EmptyState,
  Input,
  Select,
  Spinner,
  Stepper,
  TicketNumber,
} from '@qm/ui';
import type { CountryCode, PhoneState } from '@qm/ui/phone';
import { useQueryClient } from '@tanstack/react-query';
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { useTranslation } from '../../lib/translation.tsx';
import { useConnectionState } from '../../lib/live.ts';
import { detectLocale, setGuestLocale } from '../../lib/locale.ts';
import { useSession } from '../auth/api.ts';
import { useWakeLock } from '../display/useWakeLock.ts';
import { useKioskJoin, useKioskLocation, useLocationSlug } from './api.ts';
import { PRINT_MODES, usePrintMode, type PrintMode } from './print/printMode.ts';
import { TicketSlip, type Slip } from './print/TicketSlip.tsx';
import { usePrinter, type Printer } from './printer/usePrinter.ts';
import { ticketBytes } from './printer/ticketBytes.ts';
import { AudioButton } from './a11y/AudioButton.tsx';
import type { Speech } from './a11y/speech.ts';
import { useSpeech } from './a11y/useSpeech.ts';
import { AccessibilityButton } from './a11y/AccessibilityButton.tsx';
import { useAccessibilityMode } from './a11y/useAccessibilityMode.ts';
import { usePrintSettings } from '../printing/api.ts';
import { statusUrl } from '../printing/slipUrl.ts';
import { QrSvg } from './QrSvg.tsx';
import { useIdleReset } from './useIdleReset.ts';

// libphonenumber metadata loads after the page renders, as on the join page.
const PhoneInput = lazy(() => import('@qm/ui/phone').then((m) => ({ default: m.PhoneInput })));

const LanguagePicker = lazy(() =>
  import('../i18n/LanguagePicker.tsx').then((m) => ({ default: m.LanguagePicker })),
);
/** The confirmation screen clears itself after this long, ready for the next guest. */
export const DONE_MS = 20_000;

type Reason = 'org_suspended' | 'closed' | 'paused' | 'outside_hours' | 'full';
const ERRORS = [
  'queue_not_accepting',
  'not_found',
  'rate_limited',
  'invalid_input',
  'party_size_out_of_range',
  'too_many_active_visits',
] as const;

/**
 * `/kiosk` (J-4): self check-in on a paired tablet. Everything a guest types lives under one
 * keyed subtree, so a reset (idle, "Start over", the confirmation timer) unmounts it and the next
 * guest starts from a blank welcome screen with nothing of the last one in memory.
 */
export function KioskApp() {
  const { t, i18n } = useTranslation('kiosk');
  const queryClient = useQueryClient();
  const { data: session } = useSession();
  const locationId = session?.user.app_metadata?.location_id as string | undefined;
  const slug = useLocationSlug(locationId);
  const location = useKioskLocation(locationId, slug.data);
  const connection = useConnectionState();
  const [round, setRound] = useState(0);
  const [accessible, setAccessible] = useAccessibilityMode();
  const [audio, setAudio] = useState(false);
  const speech = useSpeech(audio, i18n.language);
  const [printMode, setPrintMode] = usePrintMode();
  const printer = usePrinter();
  useWakeLock();
  // Stable, so the confirmation's countdown is not restarted by every refresh of the queues.
  const startOver = useCallback(() => {
    queryClient.getMutationCache().clear();
    // The next guest starts in the device's language, not the last guest's pick.
    void setGuestLocale(i18n, detectLocale(null, navigator.languages ?? []), false);
    // The mode belongs to the guest who chose it (D-9).
    setAccessible(false);
    setAudio(false);
    setRound((r) => r + 1);
  }, [queryClient, i18n, setAccessible, setAudio]);

  if (location.isError || slug.isError) {
    return <EmptyState title={t('error.unknown')} />;
  }
  if (!location.data) return <Spinner label={t('form.joining')} className="mx-auto my-16" />;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-4xl font-bold">{location.data.name}</h1>
        <div className="flex flex-wrap items-center gap-3">
          <ConnectionIndicator state={connection} label={t(`connection.${connection}`)} />
          <AccessibilityButton on={accessible} onToggle={setAccessible} />
          {accessible ? <AudioButton on={audio} onToggle={setAudio} /> : null}
        </div>
      </header>
      <Guest
        key={round}
        location={location.data}
        printMode={printMode}
        printer={printer}
        speech={audio ? speech : null}
        onDone={startOver}
      />
      <details className="text-xl">
        <summary className="min-h-target-big cursor-pointer py-3 text-muted">
          {t('settings.summary')}
        </summary>
        <Select
          label={t('print.setting')}
          value={printMode}
          onChange={(e) => setPrintMode(e.target.value as PrintMode)}
        >
          {PRINT_MODES.map((mode) => (
            <option key={mode} value={mode}>
              {t(`print.${mode}`)}
            </option>
          ))}
        </Select>
        {printer.supported ? (
          <div className="flex flex-wrap items-center gap-3 py-3">
            <BigButton variant="secondary" onClick={() => void printer.connect()}>
              {t('printer.connect')}
            </BigButton>
            <p data-testid="kiosk-printer-status">
              {printer.name ? t('printer.connected', { name: printer.name }) : t('printer.none')}
            </p>
            {printer.name ? (
              <BigButton
                variant="secondary"
                onClick={() =>
                  void printer.print(
                    ticketBytes(
                      {
                        location: location.data?.name ?? '',
                        queue: t('printer.testQueue'),
                        ticket: 'A000',
                        url: null,
                        tz: location.data?.tz ?? 'UTC',
                      },
                      t,
                      i18n.language,
                    ),
                  )
                }
              >
                {t('printer.test')}
              </BigButton>
            ) : null}
          </div>
        ) : null}
      </details>
    </div>
  );
}

type Location = NonNullable<ReturnType<typeof useKioskLocation>['data']>;

/** Where the guest is in the three-screen check-in: welcome, details, ticket. */
function KioskSteps({ current }: { current: 0 | 1 | 2 }) {
  const { t } = useTranslation('kiosk');
  return (
    <Stepper
      label={t('steps.label')}
      current={current}
      steps={[t('steps.start'), t('steps.details'), t('steps.ticket')]}
    />
  );
}

/** The service choice as large touch tiles: at least 104 px tall, the chosen one in the primary look. */
function ServiceTiles({
  label,
  services,
  value,
  onChange,
}: {
  label: string;
  services: { id: string | null; name: string | null }[];
  value: string | null;
  onChange: (id: string) => void;
}) {
  return (
    <div role="group" aria-label={label} className="flex flex-col gap-3">
      <p className="text-xl font-medium">{label}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        {services.map((s) => (
          <Button
            key={s.id}
            variant={s.id === value ? 'primary' : 'secondary'}
            aria-pressed={s.id === value}
            className="min-h-26! justify-start px-5 text-left text-2xl"
            onClick={() => onChange(s.id ?? '')}
          >
            {s.name}
          </Button>
        ))}
      </div>
    </div>
  );
}

function Guest({
  location,
  printMode,
  printer,
  speech,
  onDone,
}: {
  location: Location;
  printMode: PrintMode;
  printer: Printer;
  /** Spoken guidance, when the guest turned audio on. */
  speech: Speech | null;
  onDone: () => void;
}) {
  const { t, i18n } = useTranslation('kiosk');
  const [screen, setScreen] = useState<'welcome' | 'form' | 'done'>('welcome');
  const [queueName, setQueueName] = useState('');
  const join = useKioskJoin();
  const { data: session } = useSession();
  const printSettings = usePrintSettings(
    session?.user.app_metadata?.location_id as string | undefined,
  );
  // The online hourly ceiling does not apply to a kiosk, so that reason still lets guests in.
  const open = (location.queues ?? []).filter(
    (q) => q.accepting || q.not_accepting_reason === 'online_full',
  );
  const idle = useIdleReset({ enabled: screen === 'form', onReset: onDone });

  // Audio guidance: say what the screen is, and the ticket on the confirmation (D-9).
  const ticket = join.data?.display_ticket ?? '';
  useEffect(() => {
    speech?.say(t(`a11y.screen.${screen}`, { ticket }), i18n.language);
  }, [speech, screen, ticket, t, i18n.language]);
  // The time-limit warning is heard as well as seen (WCAG 2.2.1).
  const warned = idle.secondsLeft !== null;
  useEffect(() => {
    if (warned) speech?.say(`${t('idle.title')} ${t('idle.more')}`, i18n.language);
  }, [warned, speech, t, i18n.language]);

  // A ticket already issued stays on screen even if the queue closes meanwhile.
  if (screen === 'done' && join.data) {
    return (
      <Done
        visit={join.data}
        slip={{
          location: location.name ?? '',
          queue: queueName,
          tz: location.tz ?? 'UTC',
          ...printSettings,
        }}
        printMode={printMode}
        printer={printer}
        onDone={onDone}
      />
    );
  }
  if (open.length === 0) {
    const reason = (location.queues?.[0]?.not_accepting_reason ?? 'closed') as Reason;
    return <EmptyState title={t('closed.title')} description={t(`closed.${reason}`)} />;
  }
  if (screen === 'welcome') {
    return (
      <Card className="flex flex-col gap-6 py-10 text-center">
        <KioskSteps current={0} />
        <p className="text-3xl">{t('welcome.title')}</p>
        <Suspense fallback={null}>
          <LanguagePicker persist={false} />
        </Suspense>
        <BigButton className="text-2xl" onClick={() => setScreen('form')}>
          {t('welcome.start')}
        </BigButton>
      </Card>
    );
  }
  return (
    <>
      <CheckInForm
        location={location}
        queues={open}
        join={join}
        onJoined={(name) => {
          setQueueName(name);
          setScreen('done');
        }}
        onCancel={onDone}
      />
      <Dialog
        open={idle.secondsLeft !== null}
        onClose={idle.extend}
        title={t('idle.title')}
        description={t('idle.body', { count: idle.secondsLeft ?? 0 })}
        footer={<BigButton onClick={idle.extend}>{t('idle.more')}</BigButton>}
      />
    </>
  );
}

function CheckInForm({
  location,
  queues,
  join,
  onJoined,
  onCancel,
}: {
  location: Location;
  queues: NonNullable<Location['queues']>;
  join: ReturnType<typeof useKioskJoin>;
  onJoined: (queueName: string) => void;
  onCancel: () => void;
}) {
  const { t, i18n } = useTranslation('kiosk');
  const [queueId, setQueueId] = useState<string | null>(null);
  const [serviceId, setServiceId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [party, setParty] = useState('1');
  const [phone, setPhone] = useState<string | null>(null);
  const [phoneState, setPhoneState] = useState<PhoneState>('empty');
  const [showMissing, setShowMissing] = useState(false);
  const key = useRef(crypto.randomUUID());
  const queue = queues.find((q) => q.id === queueId) ?? queues[0]!;
  const services = queue.services ?? [];
  const service = services.find((s) => s.id === serviceId) ?? services[0];
  const failure = join.isError ? errorCode(join.error) : null;
  const errorKey = (ERRORS as readonly string[]).includes(failure ?? '') ? failure : 'unknown';

  function submit(event: FormEvent) {
    event.preventDefault();
    if (join.isPending || join.isSuccess) return;
    if (name.trim() === '' || phoneState === 'invalid') {
      setShowMissing(true);
      return;
    }
    join.mutate(
      {
        queueId: queue.id!,
        serviceId: service?.id ?? null,
        name: name.trim(),
        phoneE164: phone,
        partySize: Math.min(Math.max(Number.parseInt(party, 10) || 1, 1), 20),
        locale: i18n.language,
        key: key.current,
      },
      { onSuccess: () => onJoined(queue.name ?? '') },
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-5" noValidate>
      <KioskSteps current={1} />
      <h2 className="text-3xl font-semibold">{t('form.title')}</h2>
      {queues.length > 1 ? (
        <Select
          label={t('form.queue')}
          value={queue.id ?? ''}
          onChange={(e) => {
            setQueueId(e.target.value);
            setServiceId(null);
          }}
        >
          {queues.map((q) => (
            <option key={q.id} value={q.id ?? ''}>
              {q.name}
            </option>
          ))}
        </Select>
      ) : null}
      {services.length > 1 ? (
        <ServiceTiles
          label={t('form.service')}
          services={services}
          value={service?.id ?? null}
          onChange={setServiceId}
        />
      ) : null}
      <Input
        label={t('form.name')}
        autoComplete="off"
        maxLength={50}
        required
        value={name}
        error={showMissing && name.trim() === '' ? t('form.nameMissing') : undefined}
        onChange={(e) => setName(e.target.value)}
      />
      <Input
        label={t('form.party')}
        type="number"
        inputMode="numeric"
        min={1}
        max={20}
        value={party}
        onChange={(e) => setParty(e.target.value)}
      />
      <Suspense fallback={<Input label={t('form.phone')} disabled />}>
        <PhoneInput
          label={t('form.phone')}
          countryLabel={t('form.country')}
          hint={t('form.phoneHint')}
          defaultCountry={(location.country_code as CountryCode | null) ?? 'US'}
          error={showMissing && phoneState === 'invalid' ? t('form.phoneInvalid') : undefined}
          onChange={setPhone}
          onStateChange={setPhoneState}
          locale={i18n.language}
        />
      </Suspense>
      {failure ? (
        <p role="alert" className="text-xl font-medium text-danger-strong">
          {t(`error.${errorKey as (typeof ERRORS)[number] | 'unknown'}`)}
        </p>
      ) : null}
      <BigButton type="submit" loading={join.isPending} loadingLabel={t('form.joining')}>
        {t('form.submit')}
      </BigButton>
      <BigButton variant="secondary" onClick={onCancel}>
        {t('form.cancel')}
      </BigButton>
    </form>
  );
}

function Done({
  visit,
  slip,
  printMode,
  printer,
  onDone,
}: {
  visit: NonNullable<ReturnType<typeof useKioskJoin>['data']>;
  slip: Pick<Slip, 'location' | 'queue' | 'tz' | 'paper' | 'footer'>;
  printMode: PrintMode;
  printer: Printer;
  onDone: () => void;
}) {
  const { t, i18n } = useTranslation('kiosk');
  const [left, setLeft] = useState(DONE_MS / 1000);
  useEffect(() => {
    const end = Date.now() + DONE_MS;
    const timer = setInterval(() => {
      const remaining = end - Date.now();
      if (remaining <= 0) onDone();
      else setLeft(Math.ceil(remaining / 1000));
    }, 250);
    return () => clearInterval(timer);
  }, [onDone]);
  const url = statusUrl(window.location.origin, visit.token);
  const bytes = useMemo(
    () => ticketBytes({ ...slip, ticket: visit.display_ticket ?? '', url }, t, i18n.language),
    // the join time on the slip is taken once, when the confirmation appears
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  // 'always' prints once, as soon as the confirmation (and the slip in it) is on screen.
  const printed = useRef(false);
  useEffect(() => {
    if (printMode !== 'always' || printed.current) return;
    printed.current = true;
    void printer.print(bytes);
  }, [printMode, printer, bytes]);
  return (
    <Card className="flex flex-col items-center gap-5 py-8 text-center" role="status">
      <KioskSteps current={2} />
      <h2 className="text-3xl font-semibold">{t('done.title')}</h2>
      <p className="text-muted">{t('done.ticket')}</p>
      <p data-testid="kiosk-ticket">
        <TicketNumber ticket={visit.display_ticket ?? ''} size="tv" />
      </p>
      {url ? (
        <>
          <QrSvg url={url} label={t('done.qrAlt')} className="size-64" />
          <p className="text-xl">{t('done.scan')}</p>
        </>
      ) : null}
      <p className="text-muted">{t('done.clears', { count: left })}</p>
      {printMode === 'ask' ? (
        <BigButton variant="secondary" onClick={() => void printer.print(bytes)}>
          {t('print.button')}
        </BigButton>
      ) : null}
      <BigButton onClick={onDone}>{t('done.finish')}</BigButton>
      {printMode === 'off' ? null : (
        <TicketSlip slip={{ ...slip, ticket: visit.display_ticket ?? '', url }} />
      )}
    </Card>
  );
}
