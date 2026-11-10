import { errorCode, type ConsentBusiness, type ErrorCode } from '@qm/domain';
import { BigButton, Button, Card, EmptyState, Input, Select, Spinner } from '@qm/ui';
import type { CountryCode, PhoneState } from '@qm/ui/phone';
import { useNavigate } from '@tanstack/react-router';
import { lazy, Suspense, useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from '../../lib/translation.tsx';
import {
  groupKeyFor,
  rememberGroup,
  rememberJoinPage,
  type GroupMember,
  useActiveVisit,
  useJoinQueue,
  type JoinInput,
  useLocationPublic,
  useJoinForm,
  useLocationWait,
  useLocationLines,
} from './api.ts';
import { forgetHistory, historyFor, recordJoin } from './history.ts';
import { JoinStateBanner } from './JoinState.tsx';
import { JoinWait } from './JoinWait.tsx';
import { CaptchaProblem } from '../../components/CaptchaProblem.tsx';
import { joinErrorKey, type NotAcceptingReason, refusalReason } from './joinErrors.ts';
import { joinSource } from './source.ts';
import { joinProvider, type Geo } from './captcha/publicJoin.ts';
import { PublicJoinError } from './captcha/publicJoin.ts';
import { RetryNotice } from './captcha/RetryNotice.tsx';
import { usePow } from './captcha/usePow.ts';
import { RpcError } from './rpcError.ts';
import { PrivacyContactNotice, parsePrivacyContact } from './PrivacyContactNotice.tsx';
import { RetentionNotice } from './RetentionNotice.tsx';
import { QuietBoundary } from '../../components/QuietBoundary.tsx';
import { formAnswers, focusAnswer, type FormDraft } from './formFields.ts';

const LanguagePicker = lazy(() =>
  import('../i18n/LanguagePicker.tsx').then((m) => ({ default: m.LanguagePicker })),
);
// The location prompt only exists for queues that ask to be on site, so it stays off the route budget.
// Shown only inside the embeddable widget (/w), after a join.
// Cloudflare's widget glue is only for deployments that turned Turnstile on.
const Turnstile = lazy(() =>
  import('../../components/Turnstile.tsx').then((m) => ({ default: m.Turnstile })),
);
const WidgetDone = lazy(() => import('./WidgetDone.tsx'));
const ShareLocation = lazy(() => import('./ShareLocation.tsx'));
const PartyStepper = lazy(() => import('./PartyStepper.tsx'));
// The form's questions render only for queues that have some: off the route budget.
const FormFields = lazy(() => import('./FormFields.tsx'));
// Shown only after an already_in_queue refusal: off the route budget.
const AlreadyInQueue = lazy(() => import('./AlreadyInQueue.tsx'));
// The person picker appears only for locations with provider lines or an Anyone available pool.
const ProviderPicker = lazy(() =>
  import('./ProviderPicker.tsx').then((m) => ({ default: m.ProviderPicker })),
);
// The Now / Later picker (J-13) loads only for queues that offer joining later.
const JoinLater = lazy(() => import('./JoinLater.tsx'));

// libphonenumber metadata is ~42 KB gzip: it loads after the page renders, off the budget.
const ConsentOptIn = lazy(() =>
  import('./ConsentOptIn.tsx').then((m) => ({ default: m.ConsentOptIn })),
);
const PhoneInput = lazy(() => import('@qm/ui/phone').then((m) => ({ default: m.PhoneInput })));

/** A join in progress: everyone's names, the shared inputs, and who has joined so far. */
interface JoinRun {
  queueId: string;
  names: string[];
  groupKey: string | null;
  members: GroupMember[];
  /** Set when the guest ticked the text opt-in: what to record once the join succeeds. */
  consent: { business: ConsentBusiness; locale: string } | null;
  input: Omit<JoinInput, 'captchaToken' | 'group'>;
}

/**
 * `/q/:slug` (J-1): pick a queue and service when there is a choice, give a first name and
 * optionally a phone, join, land on the status page. The database decides whether a queue
 * accepts; this page only renders that answer. In `widget` mode (`/w/:slug`, J7) the page sits
 * in another site's iframe, so it never navigates the frame: a joined guest gets a link that
 * opens their status page in a new tab.
 */
export function JoinPage({ slug, widget = false }: { slug: string; widget?: boolean }) {
  const { t, i18n } = useTranslation('guest');
  const navigate = useNavigate();
  // A returning guest's last join here fills in the form (G-12). Consent is never carried over.
  // The widget sits in another site's frame, so it neither reads nor writes history.
  const [previous, setPrevious] = useState(() => (widget ? null : historyFor(slug)));
  // The guest's own pick; until then a `?for=<line>` link's line (the database resolves it), then history.
  const [picked, setQueueId] = useState<string | null>(null);
  const [previousQueueId, setPreviousQueueId] = useState(previous?.queueId ?? null);
  const forLine = new URLSearchParams(window.location.search).get('for');
  const lines = useLocationLines(slug, forLine);
  const linked = lines.data?.find((l) => l.selected)?.queue_id ?? null;
  // With no pick at all the picker starts on its first line the guest can join (Anyone available when offered).
  const firstOpen = lines.data?.find((l) => l.accepting)?.queue_id ?? null;
  const queueId = picked ?? linked ?? previousQueueId ?? firstOpen;
  const location = useLocationPublic(slug, queueId);
  const wait = useLocationWait(slug, location.dataUpdatedAt);
  const join = useJoinQueue();
  const { mutate: joinMutate, isPending: joining } = join;
  const [serviceId, setServiceId] = useState<string | null>(previous?.serviceId ?? null);
  // The form for the picked queue and service, as the database publishes it. It is asked above the
  // early returns, so the pick is resolved here as below; a routed join asks none up front because
  // the database picks the queue after the guest submits.
  const formQueue =
    location.data?.routing === true
      ? undefined
      : ((location.data?.queues ?? []).find((q) => q.id === queueId) ?? location.data?.queues?.[0]);
  const formService =
    (formQueue?.services ?? []).find((s) => s.id === serviceId) ?? formQueue?.services?.[0];
  const form = useJoinForm(formQueue?.id ?? null, formService?.id ?? null, 'walk_in');
  // The time a guest who joins for later enters the line (J-13), from the lazy JoinLater picker.
  const [arriveAfter, setArriveAfter] = useState<string | null>(null);
  const [name, setName] = useState(previous?.name ?? '');
  // null until the guest changes it: the stepper then starts at the queue's minimum.
  const [partyChoice, setPartyChoice] = useState<number | null>(null);
  const [phone, setPhone] = useState<string | null>(null);
  // Digits that aren't a number would join with no phone, so the guest would wait for a text
  // that never comes. Refuse them; an empty phone stays fine.
  const [phoneState, setPhoneState] = useState<PhoneState>('empty');
  const [phoneInvalid, setPhoneInvalid] = useState(false);
  // The opt-in is always on screen, so a ticked box with no number must say what is missing.
  const [phoneNeeded, setPhoneNeeded] = useState(false);
  // Texts are opt-in: unticked unless the guest ticks the box (3-CG6).
  const [textConsent, setTextConsent] = useState(false);
  const [email, setEmail] = useState('');
  const [nameMissing, setNameMissing] = useState(false);
  // People joining together with this phone and email (2A-J15B), and the join in progress.
  const [others, setOthers] = useState<string[]>([]);
  const [othersMissing, setOthersMissing] = useState(false);
  const [run, setRun] = useState<JoinRun | null>(null);
  const launched = useRef<number | null>(null);
  // Only when the deployment turned Turnstile on (location.captcha_site_key).
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaRound, setCaptchaRound] = useState(0);
  // The widget can't produce a token (blocked, errored or too slow): say so, since Join stays off.
  const [captchaProblem, setCaptchaProblem] = useState(false);
  // 429 from public-join: how long the guest must wait, counted down in RetryNotice.
  const [retryUntil, setRetryUntil] = useState<number | null>(null);
  const provider = joinProvider();
  // The code on the waiting-room screen. The field appears once the database says this location wants one.
  const [onsiteCode, setOnsiteCode] = useState('');
  // Where the guest says they are, once a geofenced queue asked (2B-Q10).
  const [geo, setGeo] = useState<Geo | null>(null);
  // Answers to the queue's intake questions, and the fields the form or the database refused.
  const [draft, setDraft] = useState<FormDraft>({});
  // The database names the failing field in DETAIL (invalid_answers); the form keeps what was typed.
  const refusedField =
    join.error instanceof RpcError && errorCode(join.error) === 'invalid_answers'
      ? join.error.details
      : null;
  useEffect(() => {
    if (refusedField) focusAnswer(refusedField);
  }, [refusedField]);
  const clearRetry = useCallback(() => setRetryUntil(null), []);
  const pow = usePow(provider === 'pow' && location.data !== undefined, captchaRound);
  // Set synchronously on the first submit. `join.isPending` is not enough: a second tap that
  // lands after the answer but before the page navigates would mint a fresh key and a second visit.
  const submitted = useRef(false);
  // A guest who scans the poster again while in line goes back to their place, not a new ticket.
  const active = useActiveVisit([
    ...(location.data?.queues?.map((q) => q.id) ?? []),
    location.data?.routing ? `loc:${location.data.id}` : null,
  ]);
  const activeToken = active.data;
  useEffect(() => {
    if (activeToken && !widget)
      void navigate({ to: '/v/$token', params: { token: activeToken }, replace: true });
  }, [activeToken, navigate, widget]);

  // Public join: the proof-of-work solves while the guest types; Turnstile uses the deployment's
  // site key; the dev provider needs nothing. Without a provider the old join-pass flow applies.
  const siteKey =
    provider === 'pow' || provider === 'dev' ? null : (location.data?.captcha_site_key ?? null);

  // What goes to the server as the CAPTCHA answer, if the deployment asks for one.
  const needsCaptcha = provider === 'pow' || siteKey != null;
  function captchaFor(): string | null {
    if (provider === 'pow') return pow.token;
    if (provider === 'dev') return 'dev';
    return siteKey ? captchaToken : null;
  }
  const captcha = captchaFor();
  const captchaReady = !needsCaptcha || captcha != null;

  // Joins the people one after another: each has its own idempotency key, a single-use CAPTCHA
  // answer and (for a group) the shared group key. A reload and resubmit replays the same visits.
  useEffect(() => {
    if (!run || joining) return;
    const index = run.members.length;
    if (index === run.names.length) {
      const members = run.members.filter((m) => m.token !== '');
      if (run.names.length > 1) rememberGroup(run.queueId, members);
      rememberJoinPage(slug);
      if (!widget) {
        recordJoin({
          slug,
          queueId: run.input.queueId ?? null,
          serviceId: run.input.serviceId ?? null,
          name: run.input.name,
          at: new Date().toISOString(),
        });
      }
      const first = members[0];
      // The join is never rolled back: a failed consent call leaves texts off and the status page
      // says so with a retry.
      const consent =
        first && run.consent
          ? import('./consent.ts').then((c) =>
              c
                .grantTextConsent(first.token, run.consent!.business, run.consent!.locale)
                .catch(() => c.markConsentFailed(first.token)),
            )
          : Promise.resolve();
      void consent.then(() => {
        if (first && !widget) void navigate({ to: '/v/$token', params: { token: first.token } });
      });
      return;
    }
    if (!captchaReady || launched.current === index) return;
    launched.current = index;
    const name = run.names[index]!;
    joinMutate(
      {
        ...run.input,
        name,
        captchaToken: captcha,
        group: run.groupKey ? { key: run.groupKey, index } : null,
      },
      {
        onSuccess: ({ token }) => {
          setRun(
            (current) =>
              current && {
                ...current,
                members: [...current.members, { token: token ?? '', name }],
              },
          );
          // A CAPTCHA answer is single-use: the next person needs a fresh one.
          if (needsCaptcha && index + 1 < run.names.length) {
            setCaptchaRound((r) => r + 1);
            setCaptchaToken(null);
          }
        },
        onError: (error) => {
          submitted.current = false; // let the guest try again
          launched.current = null;
          setRun(null);
          // The token or its pass was refused: a fresh challenge, not the same answer again.
          // A proof-of-work token is single-use: any answer that reached the server spent it.
          const code = errorCode(error);
          if (code === 'captcha_required' || code === 'captcha_failed' || provider === 'pow') {
            setCaptchaRound((r) => r + 1);
            setCaptchaToken(null);
          }
          if (error instanceof PublicJoinError && error.status === 429) {
            setRetryUntil(Date.now() + (error.retryAfter ?? 60) * 1000);
          }
        },
      },
    );
  }, [
    run,
    joining,
    joinMutate,
    captchaReady,
    captcha,
    needsCaptcha,
    provider,
    slug,
    navigate,
    widget,
  ]);

  // Widget mode never navigates the frame: the guest's place is a link to a new tab.
  const widgetToken = widget
    ? run && run.members.length === run.names.length
      ? run.members.find((m) => m.token !== '')?.token
      : activeToken
    : null;
  if (widgetToken)
    return (
      <Suspense fallback={<Spinner label={t('join.loading')} className="mx-auto my-16" />}>
        <WidgetDone token={widgetToken} />
      </Suspense>
    );
  if (location.isPending || active.isLoading || (activeToken && !widget))
    return <Spinner label={t('join.loading')} className="mx-auto my-16" />;
  if (location.isError) {
    const missing = errorCode(location.error) === 'not_found';
    return (
      <EmptyState
        title={t(missing ? 'join.notFound.title' : 'join.loadFailed.title')}
        description={t(missing ? 'join.notFound.body' : 'join.loadFailed.body')}
      />
    );
  }

  const queues = location.data.queues ?? [];
  // Empty unless the location has provider or pool lines; the picker then replaces the queue select.
  const pickerLines = lines.data ?? [];
  const queue = queues.find((q) => q.id === queueId) ?? queues[0];
  // With routing rules (Q-11) the guest picks a service and the database picks the queue, so
  // nothing that belongs to one queue (its wait, questions or party size) is shown up front.
  const routed = location.data.routing === true;
  const locationId = location.data.id;
  const services = routed ? queues.flatMap((q) => q.services ?? []) : (queue?.services ?? []);
  const service = services.find((s) => s.id === serviceId) ?? services[0];
  const accepting = routed ? queues.some((q) => q.accepting === true) : queue?.accepting === true;
  const bounds = routed ? undefined : wait.data?.find((w) => w.queue_id === queue?.id);
  const fields = form.data ?? [];
  const joinLaterHours = bounds?.join_later_max_hours ?? null;
  const partyMin = bounds?.party_size_min ?? null;
  const partyMax = bounds?.party_size_max ?? null;
  const party =
    partyMin !== null && partyMax !== null
      ? Math.min(partyMax, Math.max(partyMin, partyChoice ?? partyMin))
      : 1;
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!(routed ? locationId : queue?.id) || submitted.current) return;
    const missing = name.trim() === '';
    const badPhone = phoneState === 'invalid';
    const needPhone = textConsent && !phone && location.data?.sms_enabled === true;
    const blankOther = others.some((n) => n.trim() === '');
    if (missing || badPhone || needPhone || blankOther) {
      setNameMissing(missing);
      setPhoneInvalid(badPhone);
      setPhoneNeeded(needPhone && !badPhone);
      setOthersMissing(blankOther);
      return;
    }
    submitted.current = true;
    launched.current = null;
    const scope = routed ? `loc:${locationId}` : queue!.id!;
    setRun({
      queueId: scope,
      names: [name.trim(), ...others.map((n) => n.trim())],
      groupKey: others.length > 0 ? groupKeyFor(scope) : null,
      members: [],
      consent:
        textConsent && phone && location.data?.sms_enabled
          ? {
              business: { name: location.data.name ?? '', contact: location.data.contact ?? null },
              locale: i18n.language,
            }
          : null,
      input: {
        queueId: routed ? null : queue!.id!,
        locationId: routed ? locationId! : undefined,
        serviceId: service?.id ?? null,
        name: name.trim(),
        phoneE164: phone,
        email: email.trim() || null,
        locale: i18n.language,
        onsiteCode: onsiteCode.trim() || null,
        geo,
        src: joinSource(window.location.search, widget),
        partySize: party,
        answers: formAnswers(fields, draft),
        arriveAfter: joinLaterHours !== null ? arriveAfter : null,
      },
    });
  }

  const joined = join.data && !join.data.token ? join.data.display_ticket : null;
  const failure: ErrorCode | null = join.isError ? errorCode(join.error) : null;
  // Learned from the first refusal; the form keeps what the guest typed.
  const onsiteNeeded =
    failure === 'onsite_code_required' || failure === 'onsite_code_invalid' || onsiteCode !== '';
  const onsiteWrong = failure === 'onsite_code_invalid';
  const reason = (queue?.not_accepting_reason ?? 'closed') as NotAcceptingReason;
  // A refused join says what the notice above says, so once the page has followed the queue the
  // sentence appears once, not twice.
  const refusal = failure ? refusalReason(failure, join.error) : null;
  const showFailure =
    failure !== null &&
    failure !== 'onsite_code_invalid' &&
    retryUntil == null &&
    (accepting || refusal !== reason);

  return (
    <div className="flex flex-col gap-6 py-4">
      <header>
        <h1 className="text-3xl font-bold">{t('join.title')}</h1>
        <p className="text-lg text-muted">{location.data.name}</p>
        <QuietBoundary>
          <Suspense fallback={null}>
            <LanguagePicker />
          </Suspense>
        </QuietBoundary>
      </header>

      {previous ? (
        <Card className="flex flex-wrap items-center justify-between gap-3">
          <p>{t('join.history.welcome', { name: previous.name })}</p>
          <Button
            variant="secondary"
            onClick={() => {
              forgetHistory();
              setPrevious(null);
              setPreviousQueueId(null);
              setName('');
              setQueueId(null);
              setServiceId(null);
            }}
          >
            {t('join.history.forget')}
          </Button>
        </Card>
      ) : null}

      <form onSubmit={submit} className="flex flex-col gap-5" noValidate>
        {pickerLines.length > 0 && !routed ? (
          <QuietBoundary>
            <Suspense fallback={null}>
              <ProviderPicker
                lines={pickerLines}
                value={queue?.id ?? ''}
                onChange={(id) => {
                  setQueueId(id);
                  setServiceId(null);
                }}
              />
            </Suspense>
          </QuietBoundary>
        ) : null}
        {queues.length > 1 && !routed && pickerLines.length === 0 ? (
          <Select
            label={t('join.queue')}
            value={queue?.id ?? ''}
            onChange={(e) => {
              setQueueId(e.target.value);
              setServiceId(null);
            }}
          >
            {queues.map((q) => (
              <option key={q.id} value={q.id ?? ''}>
                {t('join.queueOption', { name: q.name, count: q.waiting_count ?? 0 })}
              </option>
            ))}
          </Select>
        ) : null}
        {services.length > 1 ? (
          <Select
            label={t('join.service')}
            value={service?.id ?? ''}
            onChange={(e) => setServiceId(e.target.value)}
          >
            {services.map((s) => (
              <option key={s.id} value={s.id ?? ''}>
                {s.name}
              </option>
            ))}
          </Select>
        ) : null}

        {routed ? null : (
          <JoinWait
            wait={wait.data?.find((w) => w.queue_id === queue?.id)}
            tz={location.data.tz ?? 'UTC'}
            updatedAt={wait.dataUpdatedAt}
          />
        )}

        {accepting ? null : <JoinStateBanner reason={reason} />}

        {joinLaterHours !== null ? (
          <QuietBoundary>
            <Suspense fallback={null}>
              <JoinLater
                maxHours={joinLaterHours}
                nowMs={wait.dataUpdatedAt}
                timeZone={location.data.tz ?? 'UTC'}
                onChange={setArriveAfter}
              />
            </Suspense>
          </QuietBoundary>
        ) : null}
        <Input
          label={t('join.name')}
          autoComplete="given-name"
          maxLength={50}
          required
          value={name}
          error={nameMissing ? t('join.nameMissing') : undefined}
          onChange={(e) => {
            setName(e.target.value);
            setNameMissing(false);
          }}
        />
        {partyMin !== null && partyMax !== null ? (
          <Suspense fallback={null}>
            <PartyStepper min={partyMin} max={partyMax} value={party} onChange={setPartyChoice} />
          </Suspense>
        ) : null}
        <Suspense fallback={<Input label={t('join.phone')} disabled />}>
          <PhoneInput
            label={t('join.phone')}
            countryLabel={t('join.country')}
            hint={t('join.phoneHint')}
            defaultCountry={
              (location.data.country_code as CountryCode | null) ?? regionOf(i18n.language)
            }
            error={
              phoneInvalid
                ? t('join.phoneInvalid')
                : phoneNeeded
                  ? t('join.phoneForTexts')
                  : undefined
            }
            onChange={setPhone}
            onStateChange={(state) => {
              setPhoneState(state);
              if (state !== 'invalid') setPhoneInvalid(false);
              if (state === 'valid') setPhoneNeeded(false);
            }}
            locale={i18n.language}
          />
        </Suspense>
        {location.data.name && location.data.sms_enabled ? (
          <Suspense fallback={null}>
            <ConsentOptIn
              business={{ name: location.data.name, contact: location.data.contact ?? null }}
              locale={i18n.language}
              checked={textConsent}
              onChange={setTextConsent}
            />
          </Suspense>
        ) : null}
        <Input
          label={t('join.email')}
          hint={t('join.emailHint')}
          type="email"
          inputMode="email"
          autoComplete="email"
          maxLength={254}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />

        {fields.length > 0 ? (
          <QuietBoundary>
            <Suspense fallback={null}>
              <FormFields
                fields={fields}
                draft={draft}
                errors={refusedField ? { [refusedField]: t('join.intake.invalid') } : {}}
                onChange={(key, value) => setDraft({ ...draft, [key]: value })}
              />
            </Suspense>
          </QuietBoundary>
        ) : null}

        {others.map((other, i) => (
          <div key={i} className="flex items-end gap-2">
            <div className="min-w-0 flex-1">
              <Input
                label={t('join.otherName', { number: i + 2 })}
                autoComplete="off"
                maxLength={50}
                required
                value={other}
                error={
                  othersMissing && other.trim() === ''
                    ? t('join.otherNameMissing', { number: i + 2 })
                    : undefined
                }
                onChange={(e) => {
                  setOthers(others.map((n, j) => (j === i ? e.target.value : n)));
                  setOthersMissing(false);
                }}
              />
            </div>
            <Button
              variant="secondary"
              aria-label={t('join.removePerson', { number: i + 2 })}
              onClick={() => setOthers(others.filter((_, j) => j !== i))}
            >
              ×
            </Button>
          </div>
        ))}
        <div className="flex flex-col items-start gap-1">
          <Button variant="secondary" onClick={() => setOthers([...others, ''])}>
            {t('join.addPerson')}
          </Button>
          <p className="text-sm text-muted">{t('join.addPersonHint')}</p>
        </div>
        <details className="text-sm text-muted">
          <summary className="min-h-target cursor-pointer py-3 font-medium text-fg">
            {t('join.privacy.summary')}
          </summary>
          <p>{t('join.privacy.body')}</p>
          <RetentionNotice
            business={location.data?.name ?? ''}
            days={location.data?.retention_days ?? null}
          />
          <PrivacyContactNotice contact={parsePrivacyContact(location.data?.privacy_contact)} />
        </details>

        {siteKey && accepting ? (
          <Suspense fallback={null}>
            <Turnstile
              siteKey={siteKey}
              language={i18n.language}
              round={captchaRound}
              label={t('join.captcha')}
              onToken={setCaptchaToken}
              onProblem={setCaptchaProblem}
            />
          </Suspense>
        ) : null}
        {siteKey && accepting && captchaProblem && captchaToken == null ? (
          <CaptchaProblem
            message={t('join.captchaProblem.body')}
            reloadLabel={t('join.captchaProblem.reload')}
          />
        ) : null}

        {failure === 'onsite_required' || geo ? (
          <QuietBoundary>
            <Suspense fallback={null}>
              <ShareLocation geo={geo} onShared={setGeo} />
            </Suspense>
          </QuietBoundary>
        ) : null}

        {onsiteNeeded ? (
          <Input
            label={t('join.onsiteCode')}
            hint={t('join.onsiteCodeHint')}
            inputMode="numeric"
            autoComplete="off"
            pattern="[0-9]*"
            maxLength={8}
            value={onsiteCode}
            error={onsiteWrong ? t('join.error.onsite_code_invalid') : undefined}
            onChange={(e) => setOnsiteCode(e.target.value.replace(/\D/g, ''))}
          />
        ) : null}

        {provider === 'pow' && accepting ? (
          pow.failed ? (
            <CaptchaProblem
              message={t('join.pow.failed')}
              reloadLabel={t('join.captchaProblem.reload')}
            />
          ) : (
            <p role="status" aria-live="polite" className="text-sm text-muted">
              {pow.token
                ? t('join.pow.ready')
                : t('join.pow.working', { percent: Math.round(pow.progress * 100) })}
            </p>
          )
        ) : null}

        {retryUntil != null ? <RetryNotice until={retryUntil} onDone={clearRetry} /> : null}

        {failure === 'already_in_queue' ? (
          <Suspense fallback={null}>
            <AlreadyInQueue
              detail={join.error instanceof RpcError ? join.error.details : null}
              onLeft={() => {
                submitted.current = false;
                join.reset();
              }}
            />
          </Suspense>
        ) : null}
        {showFailure && failure !== 'already_in_queue' ? (
          <p role="alert" className="font-medium text-danger-strong">
            {refusal
              ? t(`join.notAccepting.${refusal}`)
              : t(`join.error.${joinErrorKey(failure, join.error)}`)}
          </p>
        ) : null}
        {joined ? (
          <p role="status" className="font-medium">
            {t('join.alreadyJoined', { ticket: joined })}
          </p>
        ) : null}

        <BigButton
          type="submit"
          disabled={!accepting || !captchaReady || retryUntil != null}
          loading={join.isPending || run !== null}
          loadingLabel={t('join.joining')}
        >
          {t('join.submit')}
        </BigButton>
      </form>
    </div>
  );
}

/**
 * For a location with no country set, the phone picker defaults to the region in the browser's
 * locale (en-GB → GB), then US. A number typed with '+' overrides it either way.
 */
function regionOf(language: string): CountryCode {
  const region = (navigator.languages?.[0] ?? language).split('-')[1]?.toUpperCase();
  return (region && /^[A-Z]{2}$/.test(region) ? region : 'US') as CountryCode;
}
