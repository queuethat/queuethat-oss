import { useTranslation } from '../../../lib/translation.tsx';
import { useCurrentLocation } from '../../auth/current.ts';

/** Date and time in the location's zone, so "until 6 PM" means the shop's 6 PM. */
export function useFormat() {
  const { i18n } = useTranslation();
  const { location } = useCurrentLocation();
  const format = new Intl.DateTimeFormat(i18n.language, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: location?.tz,
  });
  return (at: string) => format.format(new Date(at));
}
