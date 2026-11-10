import { Checkbox, Switch } from '@qm/ui';
import { useQueries, useQuery } from '@tanstack/react-query';
import { useCurrentLocation } from '../../../auth/current.ts';
import { useTranslation } from '../../../../lib/translation.tsx';
import { queuesQuery } from '../../queues/api.ts';
import { scopeStaffQuery, useSetScopeStaff } from './api.ts';

/** Every line (queue) at the org's locations, tagged with its location name. */
export function useOrgLines(orgId: string) {
  const locations = useCurrentLocation().locations.filter((l) => l.org_id === orgId);
  const results = useQueries({ queries: locations.map((l) => queuesQuery(l.id)) });
  return locations.flatMap((l, i) =>
    (results[i]?.data ?? []).map((q) => ({
      id: q.id,
      name: q.name,
      locationId: l.id,
      locationName: l.name,
    })),
  );
}

/** The org switch: off (default) = staff see every line at their locations. */
export function ScopeStaffSetting({ orgId, canEdit }: { orgId: string; canEdit: boolean }) {
  const { t } = useTranslation('admin-team');
  const setting = useQuery(scopeStaffQuery(orgId));
  const save = useSetScopeStaff(orgId);
  if (setting.data === undefined) return null;
  return (
    <section className="flex flex-col gap-2" aria-labelledby="lines-setting-heading">
      <h2 id="lines-setting-heading" className="text-xl font-semibold">
        {t('lines.title')}
      </h2>
      <Switch
        label={t('lines.toggle')}
        hint={setting.data ? t('lines.onHint') : t('lines.offHint')}
        checked={setting.data}
        disabled={!canEdit || save.isPending}
        onChange={(event) => save.mutate(event.target.checked)}
      />
      <p role="alert" className="font-medium text-danger-strong empty:hidden">
        {save.error ? t('errors.permission_denied') : null}
      </p>
    </section>
  );
}

/** Choose the lines one staff member works. Null = every line (front desk). */
export function LinePicker({
  orgId,
  value,
  onChange,
}: {
  orgId: string;
  value: string[] | null;
  onChange: (next: string[] | null) => void;
}) {
  const { t } = useTranslation('admin-team');
  const lines = useOrgLines(orgId);
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="font-medium">{t('lines.pickerLabel')}</legend>
      <p className="text-muted">{t('lines.pickerHint')}</p>
      <Checkbox
        label={t('lines.allLines')}
        checked={value === null}
        onChange={() => onChange(null)}
      />
      {lines.map((l) => (
        <Checkbox
          key={l.id}
          label={`${l.name} · ${l.locationName}`}
          checked={value?.includes(l.id) ?? false}
          onChange={(event) => {
            const current = value ?? [];
            onChange(
              event.target.checked ? [...current, l.id] : current.filter((id) => id !== l.id),
            );
          }}
        />
      ))}
    </fieldset>
  );
}
