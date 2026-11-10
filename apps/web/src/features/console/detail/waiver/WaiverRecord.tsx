import { localDateTimeValue } from '@qm/domain';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from '../../../../lib/translation.tsx';
import { useCurrentLocation } from '../../../auth/current.ts';
import { visitWaiversQuery } from './api.ts';

/**
 * What the guest agreed to, on the visit detail sheet (W4): "Agreed v3, 2026-11-09 10:42, Ann Lee".
 * Shows nothing for a visit with no accepted agreement. The record is evidence, so it is read-only.
 */
export function WaiverRecord({ visitId }: { visitId: string }) {
  const { t } = useTranslation('staff');
  const { location } = useCurrentLocation();
  const records = useQuery(visitWaiversQuery(visitId));
  if (!location || !records.data || records.data.length === 0) return null;
  return (
    <section
      className="flex flex-col gap-2"
      aria-labelledby="visit-waiver-title"
      data-testid="visit-waiver"
    >
      <h3 id="visit-waiver-title" className="font-medium">
        {t('console.waiver.title')}
      </h3>
      <ul className="flex flex-col gap-2">
        {records.data.map((r) => (
          <li key={r.id} className="text-sm">
            <p className="font-medium">{r.agreement}</p>
            <p>
              {t('console.waiver.agreed', {
                version: r.version,
                at: localDateTimeValue(r.acceptedAt, location.tz).replace('T', ' '),
                name: r.typedName ?? t('console.waiver.noName'),
              })}
            </p>
            {r.guardianName ? (
              <p className="text-muted">{t('console.waiver.guardian', { name: r.guardianName })}</p>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
