import { Button, Input, useToast } from '@qm/ui';
import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from '../../../../lib/translation.tsx';
import {
  WAIVER_RETENTION_MAX,
  WAIVER_RETENTION_MIN,
  useSetWaiverRetention,
  waiverRetentionQuery,
} from './api.ts';

/**
 * How long signed waiver records are kept (W7). Separate from guest-detail retention: answers and
 * contact details still follow the privacy retention period. The database enforces the range.
 */
export function WaiverRetention({ orgId, canEdit }: { orgId: string; canEdit: boolean }) {
  const { t } = useTranslation('admin-forms');
  const toast = useToast();
  const current = useQuery(waiverRetentionQuery(orgId));
  const save = useSetWaiverRetention(orgId);
  const [draft, setDraft] = useState<string | null>(null);
  if (!current.data) return null;
  const value = draft ?? String(current.data);
  const days = Number(value);
  const valid =
    Number.isInteger(days) && days >= WAIVER_RETENTION_MIN && days <= WAIVER_RETENTION_MAX;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate(days, {
      onSuccess: () => {
        setDraft(null);
        toast.show({ message: t('waivers.retention.saved', { count: days }) });
      },
    });
  };
  return (
    <form className="flex flex-col gap-2" onSubmit={submit} data-testid="waiver-retention">
      <h3 className="font-medium">{t('waivers.retention.title')}</h3>
      <p className="text-sm text-muted">{t('waivers.retention.explain')}</p>
      <Input
        label={t('waivers.retention.label')}
        hint={t('waivers.retention.hint', { min: WAIVER_RETENTION_MIN, max: WAIVER_RETENTION_MAX })}
        type="number"
        inputMode="numeric"
        min={WAIVER_RETENTION_MIN}
        max={WAIVER_RETENTION_MAX}
        value={value}
        readOnly={!canEdit}
        error={draft !== null && !valid ? t('waivers.retention.invalid') : undefined}
        onChange={(event) => setDraft(event.target.value)}
      />
      {canEdit ? (
        <Button
          type="submit"
          className="self-start"
          disabled={!valid || draft === null}
          loading={save.isPending}
        >
          {t('waivers.retention.save')}
        </Button>
      ) : (
        <p className="text-sm text-muted">{t('waivers.retention.readOnly')}</p>
      )}
      <p role="alert" className="text-sm font-medium text-danger-strong empty:hidden">
        {save.isError ? t('waivers.retention.error') : null}
      </p>
    </form>
  );
}
