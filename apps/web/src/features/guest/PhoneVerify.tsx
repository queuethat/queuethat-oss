import { Button, Input } from '@qm/ui';
import { useState } from 'react';
import { useTranslation } from '../../lib/translation.tsx';
import { usePow } from './captcha/usePow.ts';
import { joinProvider } from './captcha/publicJoin.ts';
import { useRequestPhoneCode, useVerifyPhoneCode } from './phoneVerify.ts';

/**
 * "Confirm your phone number" on the status page for a guest whose texts are on (#986). The code
 * request goes through public-join behind a CAPTCHA (a proof of work the phone solves in the
 * background; Turnstile deployments are not offered this box yet), checking it is a plain RPC.
 */
export function PhoneVerify({ token }: { token: string }) {
  const { t } = useTranslation('guest');
  // A solved proof is single-use, so each request moves on to a fresh round.
  const [round, setRound] = useState(0);
  const pow = usePow(joinProvider() === 'pow', round);
  const dev = joinProvider() === 'dev';
  const request = useRequestPhoneCode(token);
  const verify = useVerifyPhoneCode(token);
  const [code, setCode] = useState('');
  const [done, setDone] = useState(false);

  const captcha = dev ? 'dev' : pow.token;
  const requested = request.data?.state === 'sent';
  const verified = done || request.data?.state === 'verified' || verify.data === 'verified';
  const errorCode = (request.error as { code?: string } | null)?.code ?? '';

  if (verified) {
    return (
      <p role="status" className="font-medium">
        {t('status.phoneVerify.verified')}
      </p>
    );
  }
  return (
    <section aria-labelledby="phone-verify" className="flex flex-col gap-3">
      <h2 id="phone-verify" className="text-lg font-semibold">
        {t('status.phoneVerify.title')}
      </h2>
      <p>{t('status.phoneVerify.hint')}</p>
      {requested ? <p role="status">{t('status.phoneVerify.sent')}</p> : null}
      {requested ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            verify.mutate(code.trim(), { onSuccess: (state) => setDone(state === 'verified') });
          }}
        >
          <Input
            label={t('status.phoneVerify.codeLabel')}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          />
          <Button
            type="submit"
            className="min-h-target-big w-full"
            disabled={code.trim().length !== 6}
            loading={verify.isPending}
            loadingLabel={t('status.phoneVerify.confirming')}
          >
            {t('status.phoneVerify.confirm')}
          </Button>
          {verify.data === 'invalid' ? (
            <p role="alert" className="font-medium text-danger-strong">
              {t('status.phoneVerify.invalid')}
            </p>
          ) : null}
        </form>
      ) : null}
      {request.isError ? (
        <p role="alert" className="font-medium text-danger-strong">
          {errorCode === 'rate_limited'
            ? t('status.phoneVerify.errors.rate_limited')
            : errorCode === 'captcha_failed'
              ? t('status.phoneVerify.errors.captcha_failed')
              : errorCode === 'consent_required'
                ? t('status.phoneVerify.errors.consent_required')
                : errorCode === 'sms_unavailable'
                  ? t('status.phoneVerify.errors.sms_unavailable')
                  : t('status.phoneVerify.errors.unknown')}
        </p>
      ) : null}
      {!captcha && !pow.failed ? <p role="status">{t('status.phoneVerify.waiting')}</p> : null}
      <Button
        variant="secondary"
        className="min-h-target-big w-full"
        disabled={!captcha}
        loading={request.isPending}
        loadingLabel={t('status.phoneVerify.sending')}
        onClick={() => {
          if (captcha) {
            request.mutate(captcha, { onSettled: () => setRound((n) => n + 1) });
          }
        }}
      >
        {requested ? t('status.phoneVerify.resend') : t('status.phoneVerify.send')}
      </Button>
    </section>
  );
}
