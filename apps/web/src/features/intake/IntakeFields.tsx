import { useTranslation } from '../../lib/translation.tsx';
import type { Draft, IntakeField as Field } from './fields.ts';
import { IntakeField } from './IntakeField.tsx';

/**
 * The questions a queue asks on joining (Q-8), in the order the database published them, each drawn
 * by the shared `IntakeField`. Required ones say so in the label, and an error shows under the
 * field it belongs to. The database stays the authority: this only collects, and the join call
 * validates again.
 */
export function IntakeFields({
  fields,
  draft,
  errors,
  onChange,
  legend,
  marks = true,
}: {
  fields: Field[];
  draft: Draft;
  /** Field key → message, from the form's own check or the database's `invalid_answers` DETAIL. */
  errors: Record<string, string>;
  onChange: (key: string, value: string) => void;
  /** Replaces the guest-facing heading, e.g. for the staff editor. */
  legend?: string;
  /** Whether labels say required or optional; staff fill nothing that is required. */
  marks?: boolean;
}) {
  const { t } = useTranslation('guest-intake');
  return (
    <fieldset className="flex flex-col gap-4">
      <legend className="text-lg font-semibold">{legend ?? t('title')}</legend>
      {fields.map((f) => (
        <IntakeField
          key={f.key}
          field={f}
          name={`intake.${f.key}`}
          value={draft[f.key] ?? ''}
          error={errors[f.key]}
          suffix={marks ? t(f.required ? 'required' : 'optional') : undefined}
          onChange={(value) => onChange(f.key, value)}
        />
      ))}
    </fieldset>
  );
}

export default IntakeFields;
