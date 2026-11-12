import { errorCode } from '@qm/domain';
import { Button } from '@qm/ui';
import { useState } from 'react';
import { useTranslation } from '../../../../lib/translation.tsx';
import type { Answers } from '../../../guest/api.ts';
import { FormFields } from '../../../guest/FormFields.tsx';
import { draftFrom, formAnswers, type FormDraft } from '../../../guest/formFields.ts';
import type { NotesTarget } from '../../api.ts';
import { useSetVisitAnswers, useVisitAnswers } from './api.ts';

/**
 * A visit's form answers on the console detail sheet (F7, #1283): the guest's answers read-only, the
 * staff-only questions editable. Every read goes through `api.get_visit_answers`, which logs the
 * access; nothing here decides validity, the database does on save.
 */
export function VisitAnswers({ visit }: { visit: NotesTarget }) {
  const { t } = useTranslation('staff');
  const data = useVisitAnswers(visit.id);
  const save = useSetVisitAnswers(visit);
  const [draft, setDraft] = useState<FormDraft | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  if (!data.data || data.data.fields.length === 0) return null;
  const { fields, answers } = data.data;
  const mine = fields.filter((f) => f.staffOnly && f.type !== 'heading');
  const theirs = fields.filter((f) => !f.staffOnly && f.type !== 'heading');
  // The form starts from what is saved and follows it until the first edit.
  const values = draft ?? draftFrom(mine, answers);
  const answered = theirs.filter((f) => f.key in answers);

  const onSave = () => {
    // Replaces all answers, so the guest's own are sent back unchanged beside the staff fields.
    const kept = Object.fromEntries(
      theirs.flatMap((f) => (f.key in answers ? [[f.key, answers[f.key]!]] : [])),
    );
    save.mutate(
      { ...kept, ...formAnswers(mine, values) },
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
                {formatAnswer(answers[f.key]!, t('console.intake.yes'), t('console.intake.no'))}
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
          <FormFields
            fields={mine.map((f) => ({ ...f, required: false }))}
            draft={values}
            errors={errors}
            legend={t('console.intake.staffOnly')}
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

/** One stored answer as text: yes or no, the ticked options, or the name a guest signed with. */
export function formatAnswer(value: Answers[string], yes: string, no: string): string {
  if (typeof value === 'boolean') return value ? yes : no;
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'object')
    return value.guardian_name ? `${value.name} (${value.guardian_name})` : value.name;
  return String(value);
}
