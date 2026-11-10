import { Select } from '@qm/ui';
import { useTranslation } from '../../lib/translation.tsx';
import { GUEST_LOCALES, LOCALE_NAMES, setGuestLocale, type GuestLocale } from '../../lib/locale.ts';

/**
 * Lets a guest change the language of the guest pages (G-9). Options are named in their own
 * language. `persist` is off on the shared kiosk, which goes back to its device language for the
 * next guest.
 */
export function LanguagePicker({ persist = true }: { persist?: boolean }) {
  const { t, i18n } = useTranslation('guest');
  return (
    <Select
      label={t('language.label')}
      value={i18n.resolvedLanguage ?? 'en'}
      onChange={(event) => void setGuestLocale(i18n, event.target.value as GuestLocale, persist)}
    >
      {GUEST_LOCALES.map((locale) => (
        <option key={locale} value={locale} lang={locale}>
          {LOCALE_NAMES[locale]}
        </option>
      ))}
    </Select>
  );
}
