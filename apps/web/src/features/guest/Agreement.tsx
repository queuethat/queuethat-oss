import { Checkbox, Input } from '@qm/ui';
import { Fragment } from 'react';
import { useTranslation } from '../../lib/translation.tsx';
import { guardianKey, type FormDraft, type FormField } from './formFields.ts';
import { parseRichText, type RichRun } from './richText.ts';

const Runs = ({ runs }: { runs: RichRun[] }) => (
  <>
    {runs.map((r, i) =>
      r.bold ? <strong key={i}>{r.text}</strong> : <Fragment key={i}>{r.text}</Fragment>,
    )}
  </>
);

/**
 * A business's agreement: its title and text laid out to read on a phone, then an unticked box.
 * Ticking is the guest's own act and is never preselected. The database records what was shown
 * and when; this only collects.
 */
export function Agreement({
  field,
  accepted,
  error,
  mark,
  onChange,
}: {
  field: FormField;
  accepted: boolean;
  error: string | undefined;
  mark: string;
  onChange: (accepted: boolean) => void;
}) {
  const { t } = useTranslation('guest-intake');
  const id = `agreement-${field.key}`;
  return (
    <section className="flex flex-col gap-3" aria-labelledby={id} data-testid="agreement">
      <h3 id={id} className="text-base font-semibold">
        {field.label}
      </h3>
      <div className="flex flex-col gap-2 text-base leading-relaxed">
        {parseRichText(field.body ?? '').map((b, i) =>
          b.kind === 'ul' ? (
            <ul key={i} className="list-disc ps-6">
              {b.items.map((item, j) => (
                <li key={j}>
                  <Runs runs={item} />
                </li>
              ))}
            </ul>
          ) : (
            <p key={i}>
              {b.runs.map((line, j) => (
                <Fragment key={j}>
                  {j > 0 ? <br /> : null}
                  <Runs runs={line} />
                </Fragment>
              ))}
            </p>
          ),
        )}
      </div>
      <Checkbox
        label={`${t('agreement.accept')} (${mark})`}
        name={`answer.${field.key}`}
        error={error}
        hint={field.help ?? undefined}
        checked={accepted}
        onChange={(e) => onChange(e.target.checked)}
      />
    </section>
  );
}

/** A typed name (and a parent or guardian's, when the business asks) to go with an agreement. */
export function Signature({
  field,
  draft,
  error,
  mark,
  onChange,
}: {
  field: FormField;
  draft: FormDraft;
  error: string | undefined;
  mark: string;
  onChange: (key: string, value: string) => void;
}) {
  const { t } = useTranslation('guest-intake');
  const name = draft[field.key];
  const guardian = draft[guardianKey(field.key)];
  return (
    <div className="flex flex-col gap-3" data-testid="signature">
      <Input
        label={`${field.label} (${mark})`}
        name={`answer.${field.key}`}
        hint={field.help ?? t('signature.hint')}
        error={error}
        required={field.required}
        autoComplete="name"
        minLength={2}
        maxLength={120}
        value={typeof name === 'string' ? name : ''}
        onChange={(e) => onChange(field.key, e.target.value)}
      />
      {field.collectGuardian ? (
        <Input
          label={t('signature.guardian')}
          name={`answer.${field.key}.guardian`}
          hint={t('signature.guardianHint')}
          autoComplete="off"
          maxLength={120}
          value={typeof guardian === 'string' ? guardian : ''}
          onChange={(e) => onChange(guardianKey(field.key), e.target.value)}
        />
      ) : null}
    </div>
  );
}
