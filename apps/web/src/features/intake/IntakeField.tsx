import { Checkbox, Input, Select } from '@qm/ui';

/** What a renderer needs of an intake question (Q-8). */
export interface IntakeFieldDef {
  key: string;
  label: string;
  help: string | null;
  type: 'text' | 'select' | 'checkbox' | 'phone' | 'number' | 'date';
  options: string[] | null;
  required: boolean;
}

/**
 * One intake question as a guest sees it. The admin builder previews with this component and
 * the join page will render with it too (2A-GST10), so the two cannot drift.
 */
export function IntakeField({
  field,
  value,
  onChange,
  name,
  error,
  suffix,
}: {
  field: IntakeFieldDef;
  value: string;
  onChange: (value: string) => void;
  /** The control's name, so a form can move focus to it. */
  name?: string;
  /** Shown under the control and announced. */
  error?: string;
  /** Appended to the label, e.g. "optional". */
  suffix?: string;
}) {
  const label = suffix ? `${field.label} (${suffix})` : field.label;
  const common = {
    label,
    name,
    error,
    hint: field.help ?? undefined,
    required: field.required,
  };
  switch (field.type) {
    case 'select':
      return (
        <Select {...common} value={value} onChange={(event) => onChange(event.target.value)}>
          <option value="" />
          {(field.options ?? []).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </Select>
      );
    case 'checkbox':
      return (
        <Checkbox
          label={label}
          name={name}
          error={error}
          hint={field.help ?? undefined}
          checked={value === 'true'}
          onChange={(event) => onChange(event.target.checked ? 'true' : 'false')}
        />
      );
    default: {
      const html = { phone: 'tel', number: 'number', date: 'date', text: 'text' }[field.type];
      return (
        <Input
          {...common}
          type={html}
          maxLength={field.type === 'text' ? 500 : undefined}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      );
    }
  }
}
