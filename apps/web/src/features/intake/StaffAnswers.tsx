import { errorCode } from '@qm/domain';
import { Button } from '@qm/ui';
import { useState } from 'react';
import { useTranslation } from '../../lib/translation.tsx';
import type { NotesTarget } from '../console/api.ts';
import { useSetVisitAnswers, useVisitAnswers } from './api.ts';
import { answersPayload, type Draft } from './fields.ts';
import { IntakeFields } from './IntakeFields.tsx';

/**
 * A visit's intake answers on the console detail sheet (Q-8): every answer is shown, and the
 * staff-only questions can be filled in. Nothing is required of staff; the database validates.
 */
export function StaffAnswers({ visit }: { visit: NotesTarget }) {
  const { t } = useTranslation('staff');
  const data = useVisitAnswers(visit);
  const save = useSetVisitAnswers(visit);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  if (!data.data || data.data.fields.length === 0) return null;
  const { fields, answers } = data.data;
  const mine = fields.filter((f) => f.staffOnly);
  const theirs = fields.filter((f) => !f.staffOnly);
  // The form starts from what is saved and follows it until the first edit.
  const values: Draft =
    draft ??
    (Object.fromEntries(
      mine.flatMap((f) => (f.key in answers ? [[f.key, String(answers[f.key])]] : [])),
    ) as Draft);
  const answered = theirs.filter((f) => f.key in answers);

  const onSave = () => {
    // Replaces all answers, so the guest's own are sent back unchanged beside the staff fields.
    const kept = Object.fromEntries(
      theirs.flatMap((f) => (f.key in answers ? [[f.key, answers[f.key]!]] : [])),
    );
    save.mutate(
      { ...kept, ...answersPayload(mine, values) },
      {
        onSuccess: () => {
          setDraft(null);
          setErrors({});
        },
        onError: (error) => {
          const key = (error as { details?: string | null }).details;
          setErrors(
            errorCode(error) === 'invalid_answers' && key
              ? { [key]: t('console.intake.invalid') }
              : {},
          );
        },
      },
    );
  };

  return (
    <section
      className="flex flex-col gap-3"
      aria-label={t('console.intake.title')}
      data-testid="visit-answers"
    >
      <h3 className="text-lg font-semibold">{t('console.intake.title')}</h3>
      {theirs.length > 0 ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          {answered.map((f) => (
            <div key={f.key} className="contents">
              <dt className="text-muted">{f.label}</dt>
              <dd className="font-medium">
                {formatAnswer(answers[f.key]!, t('console.intake.yes'))}
              </dd>
            </div>
          ))}
          {answered.length === 0 ? (
            <dd className="col-span-2 text-muted">{t('console.intake.none')}</dd>
          ) : null}
        </dl>
      ) : null}
      {mine.length > 0 ? (
        <>
          <IntakeFields
            fields={mine.map((f) => ({ ...f, required: false }))}
            draft={values}
            errors={errors}
            legend={t('console.intake.staffOnly')}
            marks={false}
            onChange={(key, value) => setDraft({ ...values, [key]: value })}
          />
          {save.isError && Object.keys(errors).length === 0 ? (
            <p role="alert" className="font-medium text-danger-strong">
              {errorCode(save.error) === 'stale_visit'
                ? t('console.intake.stale')
                : t('console.intake.failed')}
            </p>
          ) : null}
          <Button variant="secondary" loading={save.isPending} onClick={onSave}>
            {t('console.intake.save')}
          </Button>
        </>
      ) : null}
    </section>
  );
}

function formatAnswer(value: string | number | boolean, yes: string): string {
  return typeof value === 'boolean' ? (value ? yes : '') : String(value);
}
