import { errorCode } from '@qm/domain';
import { Input, Select, Spinner } from '@qm/ui';
import { useNavigate } from '@tanstack/react-router';
import { lazy, Suspense, useRef, useState } from 'react';
import { useTranslation } from '../../../lib/translation.tsx';
import type { Details } from '../DetailsForm.tsx';
import { localDate } from '../slots.ts';
import { useJoinWaitlist } from './api.ts';

const DetailsForm = lazy(() =>
  import('../DetailsForm.tsx').then((m) => ({ default: m.DetailsForm })),
);

// Cloudflare's widget glue is only for deployments that turned Turnstile on.
const Turnstile = lazy(() =>
  import('../../../components/Turnstile.tsx').then((m) => ({ default: m.Turnstile })),
);

const KNOWN_ERRORS = [
  'rate_limited',
  'captcha_required',
  'captcha_failed',
  'org_suspended',
  'not_found',
  'invalid_input',
];

/**
 * "Join the waitlist" (A-9): a day, an optional time window, and the guest's details. The guest is emailed
 * when a matching slot frees up; the page they land on holds the link that claims it.
 */
export function WaitlistForm({
  slug,
  tz,
  services,
  countryCode,
  retentionDays,
  captchaSiteKey,
  onBack,
}: {
  slug: string;
  tz: string;
  services: { id: string; name: string }[];
  countryCode: string | null;
  retentionDays: number | null;
  /** The deployment's Turnstile site key, else null. */
  captchaSiteKey: string | null;
  onBack: () => void;
}) {
  const { t, i18n } = useTranslation('booking');
  const navigate = useNavigate();
  const join = useJoinWaitlist();
  const today = localDate(new Date(), tz);
  const [serviceId, setServiceId] = useState(services[0]?.id ?? '');
  const [day, setDay] = useState(today);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  // A token is single use, so every refusal starts a new round.
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaRound, setCaptchaRound] = useState(0);
  const submitted = useRef(false);
  const windowOk = (from === '') === (to === '') && (from === '' || to > from);

  function submit(details: Details) {
    if (submitted.current || !windowOk || !serviceId || !day || !details.email) return;
    if (captchaSiteKey && !captchaToken) {
      setProblem('captcha_required');
      return;
    }
    submitted.current = true;
    setProblem(null);
    join.mutate(
      {
        slug,
        serviceId,
        day,
        windowStart: from || null,
        windowEnd: to || null,
        name: details.name,
        phoneE164: details.phoneE164,
        email: details.email,
        captchaToken: captchaSiteKey ? captchaToken : null,
      },
      {
        onSuccess: (token) => void navigate({ to: '/o/$token', params: { token } }),
        onError: (error) => {
          submitted.current = false;
          if (captchaSiteKey) {
            setCaptchaRound((r) => r + 1);
            setCaptchaToken(null);
          }
          const code = errorCode(error);
          setProblem(KNOWN_ERRORS.includes(code) ? code : 'unknown');
        },
      },
    );
  }

  return (
    <Suspense fallback={<Spinner label={t('book.loading')} />}>
      <DetailsForm
        summary={t('waitlist.summary')}
        countryCode={countryCode}
        retentionDays={retentionDays}
        problem={problem === 'unknown' ? 'unknown' : problem}
        pending={join.isPending}
        emailRequired
        onBack={onBack}
        onSubmit={submit}
        extra={
          <fieldset className="flex flex-col gap-4">
            <legend className="font-semibold">{t('waitlist.when')}</legend>
            {services.length > 1 ? (
              <Select
                label={t('book.service')}
                value={serviceId}
                onChange={(e) => setServiceId(e.target.value)}
              >
                {services.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            ) : null}
            <Input
              label={t('waitlist.day')}
              type="date"
              min={today}
              value={day}
              onChange={(e) => e.target.value && setDay(e.target.value)}
            />
            <div className="flex flex-wrap gap-4">
              <Input
                label={t('waitlist.from')}
                type="time"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              />
              <Input
                label={t('waitlist.to')}
                type="time"
                value={to}
                error={windowOk ? undefined : t('waitlist.windowInvalid')}
                onChange={(e) => setTo(e.target.value)}
              />
            </div>
            <p className="text-sm text-muted">{t('waitlist.windowHint')}</p>
            {captchaSiteKey ? (
              <Turnstile
                siteKey={captchaSiteKey}
                language={i18n.language}
                round={captchaRound}
                label={t('book.captcha')}
                onToken={setCaptchaToken}
                onProblem={() => undefined}
              />
            ) : null}
          </fieldset>
        }
      />
    </Suspense>
  );
}
