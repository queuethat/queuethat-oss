import { Checkbox, Input, Select, Textarea } from '@qm/ui';
import { useState } from 'react';
import { useTranslation } from '../../../../lib/translation.tsx';
import {
  fieldProblems,
  fieldWarnings,
  hasOptions,
  isEvidence,
  isStatic,
  MAX_BODY,
  parseOptions,
  patchField,
  type BuilderField,
  type Sensitivity,
  type Visibility,
} from './fields.ts';

export interface FieldEditorProps {
  field: BuilderField;
  healthTagged: boolean;
  onChange: (field: BuilderField) => void;
}

/** Edits one field in place. The type and key are fixed once a field exists. */
export function FieldEditor({ field, healthTagged, onChange }: FieldEditorProps) {
  const { t } = useTranslation('admin-form-builder');
  const [optionText, setOptionText] = useState((field.options ?? []).join('\n'));
  const set = (patch: Partial<BuilderField>) => onChange(patchField(field, patch));
  const problems = fieldProblems(field);
  const warnings = fieldWarnings(field, healthTagged);
  const fixed = isStatic(field.type);
  const evidence = isEvidence(field.type);

  return (
    <div className="flex flex-col gap-3">
      <Input
        label={t(
          field.type === 'heading'
            ? 'editor.headingText'
            : field.type === 'agreement'
              ? 'editor.agreementTitle'
              : field.type === 'signature'
                ? 'editor.signatureLabel'
                : 'editor.label',
        )}
        value={field.label}
        maxLength={120}
        error={problems.includes('label') ? t('editor.labelRequired') : undefined}
        onChange={(e) => set({ label: e.target.value })}
      />
      <Input
        label={t('editor.help')}
        hint={t('editor.helpHint')}
        value={field.help ?? ''}
        maxLength={300}
        onChange={(e) => set({ help: e.target.value })}
      />
      {field.type === 'agreement' ? (
        <Textarea
          label={t('editor.body')}
          hint={t('editor.bodyHint')}
          rows={8}
          maxLength={MAX_BODY}
          value={field.body ?? ''}
          error={
            problems.includes('body')
              ? t('editor.bodyRequired')
              : problems.includes('markup')
                ? t('editor.bodyMarkup')
                : undefined
          }
          onChange={(e) => set({ body: e.target.value })}
        />
      ) : null}
      {field.type === 'signature' ? (
        <Checkbox
          label={t('editor.guardian')}
          hint={t('editor.guardianHint')}
          checked={field.collect_guardian === true}
          onChange={(e) => set({ collect_guardian: e.target.checked })}
        />
      ) : null}
      {hasOptions(field.type) ? (
        <Textarea
          label={t('editor.options')}
          hint={t('editor.optionsHint')}
          rows={4}
          value={optionText}
          error={
            problems.includes('options')
              ? t('editor.optionsRequired')
              : problems.includes('duplicate')
                ? t('editor.optionsDuplicate')
                : undefined
          }
          onChange={(e) => {
            setOptionText(e.target.value);
            set({ options: parseOptions(e.target.value) });
          }}
        />
      ) : null}
      {fixed ? null : (
        <>
          <Checkbox
            label={t('editor.required')}
            checked={field.required === true}
            onChange={(e) => set({ required: e.target.checked })}
          />
          {evidence ? null : (
            <>
              <Select
                label={t('editor.visibility')}
                value={field.visibility ?? 'guest'}
                onChange={(e) => set({ visibility: e.target.value as Visibility })}
              >
                <option value="guest">{t('editor.visibilityGuest')}</option>
                <option value="staff_only">{t('editor.visibilityStaff')}</option>
              </Select>
              <Select
                label={t('editor.sensitivity')}
                hint={t('editor.sensitivityHint')}
                value={field.sensitivity ?? 'normal'}
                onChange={(e) => set({ sensitivity: e.target.value as Sensitivity })}
              >
                <option value="normal">{t('editor.sensitivityNormal')}</option>
                <option value="personal">{t('editor.sensitivityPersonal')}</option>
                <option value="sensitive">{t('editor.sensitivitySensitive')}</option>
              </Select>
            </>
          )}
        </>
      )}
      {warnings.map((w) => (
        <p
          key={w}
          role="status"
          className="rounded-control bg-warning-soft p-3 text-warning-strong"
        >
          {t(`warnings.${w}`)}
        </p>
      ))}
    </div>
  );
}
