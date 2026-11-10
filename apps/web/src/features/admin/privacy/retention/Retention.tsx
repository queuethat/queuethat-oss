import { Button, Input, Skeleton, useToast } from '@qm/ui';
import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from '../../../../lib/translation.tsx';
import { RETENTION_MAX, RETENTION_MIN, retentionQuery, useSetRetention } from '../api.ts';

/**
 * Owner and admin control for how long guest details are kept. Shows what the chosen number means
 * and warns when shortening. The database enforces the range and the platform cap; this only
 * mirrors the hosted cap for early feedback and maps `retention_over_cap` when a cap is lower.
 */
export function Retention({ orgId, canEdit }: { orgId: string; canEdit: boolean }) {
  const { t } = useTranslation('admin-privacy');
  const toast = useToast();
  const current = useQuery(retentionQuery(orgId));
  const save = useSetRetention(orgId);
  const [draft, setDraft] = useState<string | null>(null);
  if (current.isPending) return <Skeleton label={t('loading')} rows={2} />;
  if (current.isError) return <p role="alert">{t('privacy.failed')}</p>;
  const value = draft ?? String(current.data);
  const days = Number(value);
  const valid = Number.isInteger(days) && days >= RETENTION_MIN && days <= RETENTION_MAX;
  const shortening = valid && days < current.data;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate(days, {
      onSuccess: () => {
        setDraft(null);
        toast.show({ message: t('privacy.saved', { count: days }) });
      },
    });
  };
  const overCap = save.error?.message === 'retention_over_cap';
  return (
    <form className="flex flex-col gap-3" onSubmit={submit}>
      <h2 className="text-xl font-semibold">{t('privacy.retention.title')}</h2>
      <p>{t('privacy.retention.explain')}</p>
      <Input
        label={t('privacy.retention.label')}
        hint={t('privacy.retention.hint', { min: RETENTION_MIN, max: RETENTION_MAX })}
        type="number"
        inputMode="numeric"
        min={RETENTION_MIN}
        max={RETENTION_MAX}
        value={value}
        readOnly={!canEdit}
        error={draft !== null && !valid ? t('privacy.retention.invalid') : undefined}
        onChange={(event) => setDraft(event.target.value)}
      />
      {valid ? (
        <p data-testid="retention-impact">{t('privacy.retention.impact', { count: days })}</p>
      ) : null}
      {shortening ? (
        <p data-testid="retention-shorter" className="font-medium">
          {t('privacy.retention.shorter')}
        </p>
      ) : null}
      {canEdit ? (
        <Button
          type="submit"
          className="self-start"
          disabled={!valid || draft === null}
          loading={save.isPending}
        >
          {t('privacy.retention.save')}
        </Button>
      ) : (
        <p className="text-muted">{t('privacy.retention.readOnly')}</p>
      )}
      <p role="alert" className="font-medium text-danger-strong empty:hidden">
        {save.isError
          ? overCap
            ? t('privacy.retention.overCap', { max: RETENTION_MAX })
            : t('privacy.retention.error')
          : null}
      </p>
      <section aria-labelledby="overrides-h" className="flex flex-col gap-1">
        <h3 id="overrides-h" className="font-semibold">
          {t('privacy.retention.overridesTitle')}
        </h3>
        <p className="text-muted">{t('privacy.retention.overrides')}</p>
      </section>
    </form>
  );
}
