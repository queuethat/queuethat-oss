import { useState } from 'react';
import { useTranslation } from '../../lib/translation.tsx';
import { appConfig } from '../../lib/config.ts';
import { CaptchaProblem } from '../../components/CaptchaProblem.tsx';
import { Turnstile } from '../../components/Turnstile.tsx';

/** The Turnstile site key for auth forms, or '' when this deployment doesn't use CAPTCHA. */
export function authCaptchaSiteKey(): string {
  return appConfig().authTurnstileSiteKey;
}

/**
 * CAPTCHA for a form that signs in, signs up or asks for a sign-in link, when Supabase Auth's
 * CAPTCHA is on (#76). `widget` is null without a site key, `token` is undefined, and `ready`
 * stays true, so local dev, e2e and installs without Cloudflare behave as before.
 *
 * A token buys one request. Call `refresh` after every attempt that used it (settled, success or
 * not) so the widget solves a new challenge for the next one.
 */
export function useAuthCaptcha() {
  const { t, i18n } = useTranslation('auth');
  const siteKey = authCaptchaSiteKey();
  const [token, setToken] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  // The widget can't produce a token (blocked, errored or too slow): say so, since the form's
  // button stays off until it does.
  const [problem, setProblem] = useState(false);
  return {
    widget: siteKey ? (
      <>
        <Turnstile
          siteKey={siteKey}
          language={i18n.language}
          round={round}
          label={t('captcha')}
          onToken={setToken}
          onProblem={setProblem}
        />
        {problem && token === null ? (
          <CaptchaProblem
            message={t('captchaProblem.body')}
            reloadLabel={t('captchaProblem.reload')}
          />
        ) : null}
      </>
    ) : null,
    token: token ?? undefined,
    ready: !siteKey || token !== null,
    refresh: () => setRound((r) => r + 1),
  };
}
