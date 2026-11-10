import { Card, Select, Spinner } from '@qm/ui';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from '../../../lib/translation.tsx';
import {
  SINGLE_ACTIVE_SCOPES,
  singleActiveQuery,
  useSetSingleActive,
  type SingleActiveScope,
} from './api.ts';

/** The one-active-visit rule (J-16): off, per location, or across all locations. */
export function SingleActiveVisit({ orgId, canEdit }: { orgId: string; canEdit: boolean }) {
  const { t } = useTranslation('admin');
  const current = useQuery(singleActiveQuery(orgId));
  const save = useSetSingleActive(orgId);
  if (current.isPending) return <Spinner label={t('singleActive.loading')} />;
  if (current.isError) return <p role="alert">{t('singleActive.failed')}</p>;
  return (
    <Card className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold">{t('singleActive.title')}</h2>
      <p className="text-muted">{t('singleActive.explain')}</p>
      <Select
        label={t('singleActive.label')}
        hint={t(`singleActive.hint.${current.data}`)}
        value={current.data}
        disabled={!canEdit || save.isPending}
        onChange={(e) => save.mutate(e.target.value as SingleActiveScope)}
      >
        {SINGLE_ACTIVE_SCOPES.map((s) => (
          <option key={s} value={s}>
            {t(`singleActive.option.${s}`)}
          </option>
        ))}
      </Select>
      {canEdit ? null : <p className="text-muted">{t('singleActive.readOnly')}</p>}
      <p role="alert" className="font-medium text-danger-strong empty:hidden">
        {save.isError ? t('singleActive.error') : null}
      </p>
    </Card>
  );
}
