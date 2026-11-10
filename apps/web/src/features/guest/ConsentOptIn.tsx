import { consentText, type ConsentBusiness } from '@qm/domain';
import { Checkbox } from '@qm/ui';
import { legalUrls } from '../marketing/company.ts';
import { useTranslation } from '../../lib/translation.tsx';

const legalLink = 'inline-flex min-h-target items-center underline';

/**
 * The text-alert opt-in (3-CG6): one unticked checkbox whose label is the whole published consent
 * text, so what the guest ticks is exactly what gets hashed and stored. The wording is a
 * compliance artifact generated from the database (consent-texts.ts), not a `t()` string.
 */
export function ConsentOptIn({
  business,
  locale,
  checked,
  onChange,
}: {
  business: ConsentBusiness;
  locale: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const { t } = useTranslation('guest');
  const shown = consentText('sms', locale, business) ?? consentText('sms', 'en', business);
  if (!shown) return null;
  const { terms, privacy } = legalUrls();
  return (
    <div className="flex flex-col">
      <Checkbox
        label={shown.text}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        data-testid="sms-consent"
      />
      {/* Beside the opt-in, not inside it: the hashed words stay the same on a self-hosted domain.
          An install that has published neither page shows no line at all. */}
      {terms || privacy ? (
        <p
          className="flex flex-wrap items-center gap-x-1 text-sm text-muted"
          data-testid="sms-legal"
        >
          {t('join.consentLinks.prefix')}
          {terms ? (
            <a href={terms} target="_blank" rel="noreferrer" className={legalLink}>
              {t('join.consentLinks.terms')}
            </a>
          ) : null}
          {terms && privacy ? t('join.consentLinks.and') : null}
          {privacy ? (
            <a href={privacy} target="_blank" rel="noreferrer" className={legalLink}>
              {t('join.consentLinks.privacy')}
            </a>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}
