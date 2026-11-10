import { Card } from '@qm/ui';
import { useState } from 'react';
import { useTranslation } from '../../../../../lib/translation.tsx';
import { FormFields } from '../../../../guest/FormFields.tsx';
import type { FormDraft, FormField } from '../../../../guest/formFields.ts';
import type { BuilderField } from '../fields.ts';
import { fillSeconds } from './estimate.ts';

export interface PreviewProps {
  fields: BuilderField[];
  purposeText: string;
  /** The retention in force for this form, or null while the owner has not entered a valid one. */
  retentionDays: number | null;
}

const NO_ERRORS: Record<string, string> = {};

/**
 * What a guest on a phone will see: the guest page's own `FormFields` inside a phone-width
 * frame, so the two cannot drift. Staff-only questions are left out as they are for guests.
 * Typing here is for trying it out; nothing is saved or sent.
 */
export function Preview({ fields, purposeText, retentionDays }: PreviewProps) {
  const { t } = useTranslation('admin-form-builder');
  const [draft, setDraft] = useState<FormDraft>({});
  const shown: FormField[] = fields
    .filter((f) => f.visibility !== 'staff_only')
    .map((f) => ({
      key: f.key,
      label: f.label || t(`types.${f.type}`),
      help: f.help ?? null,
      type: f.type,
      options: f.options ?? [],
      required: f.required === true,
      ...(f.type === 'agreement' ? { body: f.body ?? '' } : {}),
      ...(f.collect_guardian ? { collectGuardian: true } : {}),
    }));
  const seconds = fillSeconds(fields);

  return (
    <section aria-labelledby="builder-preview" className="flex flex-col gap-2">
      <h2 id="builder-preview" className="font-semibold">
        {t('preview.title')}
      </h2>
      <p className="text-sm text-muted">{t('preview.hint')}</p>
      <p role="status" data-testid="fill-estimate" className="font-medium">
        {seconds === 0
          ? t('preview.nothing')
          : seconds >= 90
            ? t('preview.minutes', { count: Math.round(seconds / 60) })
            : t('preview.seconds', { count: seconds })}
      </p>
      <Card
        data-testid="form-preview"
        className="mx-auto flex w-full max-w-sm flex-col gap-4 border-2"
      >
        {purposeText.trim() ? <p>{purposeText.trim()}</p> : null}
        {shown.length === 0 ? (
          <p className="text-muted">{t('preview.empty')}</p>
        ) : (
          <FormFields
            fields={shown}
            draft={draft}
            errors={NO_ERRORS}
            onChange={(key, value) => setDraft((d) => ({ ...d, [key]: value }))}
          />
        )}
        {retentionDays ? (
          <p className="text-sm text-muted" data-testid="preview-retention">
            {t('preview.retention', { count: retentionDays })}
          </p>
        ) : null}
      </Card>
    </section>
  );
}
