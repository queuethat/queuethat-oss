import { Checkbox, Input, Select, Textarea } from '@qm/ui';
import { useTranslation } from '../../lib/translation.tsx';
import { Agreement, Signature } from './Agreement.tsx';
import type { FormDraft, FormField } from './formFields.ts';

/**
 * The questions a business asks a guest on joining or booking, drawn from the form the database
 * published (`get_join_form`) in its order. Required ones say so in the label and an error shows
 * under the field it belongs to. This only collects: it never decides what is valid, so the join
 * or booking call stays the one authority and names the field it refused. Shared by the join page,
 * the booking details and (B3) the builder preview, so they cannot drift.
 */
export function FormFields({
  fields,
  draft,
  errors,
  onChange,
  legend,
}: {
  fields: readonly FormField[];
  draft: FormDraft;
  /** Field key → message, from the database's `invalid_answers` DETAIL. */
  errors: Record<string, string>;
  onChange: (key: string, value: string | boolean | string[]) => void;
  /** Replaces the default heading. */
  legend?: string;
}) {
  const { t } = useTranslation('guest-intake');
  return (
    <fieldset className="flex flex-col gap-4" data-testid="form-fields">
      <legend className="text-lg font-semibold">{legend ?? t('title')}</legend>
      {fields.map((f) => (
        <Field
          key={f.key}
          field={f}
          draft={draft[f.key]}
          all={draft}
          error={errors[f.key]}
          mark={t(f.required ? 'required' : 'optional')}
          onChange={(value) => onChange(f.key, value)}
          onChangeKey={onChange}
        />
      ))}
    </fieldset>
  );
}

function Field({
  field,
  draft,
  all,
  error,
  mark,
  onChange,
  onChangeKey,
}: {
  field: FormField;
  draft: string | boolean | string[] | undefined;
  /** The whole draft, for fields made of more than one value (a signature's guardian). */
  all: FormDraft;
  error: string | undefined;
  mark: string;
  onChange: (value: string | boolean | string[]) => void;
  /** Writes any draft key, for the second value of a signature. */
  onChangeKey: (key: string, value: string) => void;
}) {
  const { t } = useTranslation('guest-intake');
  const name = `answer.${field.key}`;
  const text = typeof draft === 'string' ? draft : '';
  const label = `${field.label} (${mark})`;
  const common = { label, name, error, hint: field.help ?? undefined, required: field.required };

  switch (field.type) {
    case 'agreement':
      return (
        <Agreement
          field={field}
          accepted={draft === true}
          error={error}
          mark={mark}
          onChange={onChange}
        />
      );
    case 'signature':
      return (
        <Signature field={field} draft={all} error={error} mark={mark} onChange={onChangeKey} />
      );
    case 'heading':
      return <h3 className="pt-2 text-base font-semibold">{field.label}</h3>;
    case 'long_text':
      return (
        <Textarea
          {...common}
          rows={4}
          maxLength={1000}
          value={text}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case 'single_choice':
      return (
        <Select {...common} value={text} onChange={(e) => onChange(e.target.value)}>
          <option value="">{t('choose')}</option>
          {field.options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </Select>
      );
    case 'multi_choice': {
      const picked = Array.isArray(draft) ? draft : [];
      return (
        <fieldset
          className="flex min-w-0 flex-col gap-1 border-0 p-0"
          aria-invalid={error ? true : undefined}
        >
          <legend className="mb-1 p-0 font-medium">{label}</legend>
          {field.help ? <p className="text-sm text-muted">{field.help}</p> : null}
          {field.options.map((o) => (
            <Checkbox
              key={o}
              label={o}
              name={name}
              checked={picked.includes(o)}
              onChange={(e) =>
                onChange(e.target.checked ? [...picked, o] : picked.filter((p) => p !== o))
              }
            />
          ))}
          {error ? <p className="text-sm font-medium text-danger-strong">{error}</p> : null}
        </fieldset>
      );
    }
    case 'yes_no':
    case 'marketing_consent':
      return (
        <Checkbox
          label={label}
          name={name}
          error={error}
          hint={field.help ?? undefined}
          checked={draft === true}
          onChange={(e) => onChange(e.target.checked)}
        />
      );
    case 'number':
      return (
        <Input
          {...common}
          type="number"
          inputMode="decimal"
          value={text}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case 'date':
      return (
        <Input {...common} type="date" value={text} onChange={(e) => onChange(e.target.value)} />
      );
    case 'phone':
      return (
        <Input
          {...common}
          type="tel"
          inputMode="tel"
          autoComplete="off"
          hint={field.help ?? t('phoneHint')}
          value={text}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case 'email':
      return (
        <Input
          {...common}
          type="email"
          inputMode="email"
          autoComplete="off"
          maxLength={254}
          value={text}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    default:
      return (
        <Input
          {...common}
          type="text"
          maxLength={500}
          value={text}
          onChange={(e) => onChange(e.target.value)}
        />
      );
  }
}

export default FormFields;
