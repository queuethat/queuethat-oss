import { useId, type InputHTMLAttributes, type ReactNode } from 'react';
import { cx } from './cx.ts';
import { useField } from './Field.tsx';

interface LabelProps {
  /** Visible label, already through t(). */
  label: string;
  hint?: string;
  /** Shown below the control and announced; also sets aria-invalid. */
  error?: string;
}

export type SwitchProps = LabelProps & Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'role'>;

/**
 * An on/off setting that takes effect as you flip it (use Checkbox for "submit with the form").
 * A native checkbox with `role="switch"`, so keyboard, label click and form state all come free.
 */
export function Switch({ label, hint, error, className, ...rest }: SwitchProps) {
  const f = useField({ hint, error });
  return (
    <div className="flex flex-col gap-1">
      <label
        htmlFor={f.id}
        className="flex min-h-target cursor-pointer items-center gap-3 font-medium"
      >
        <input
          id={f.id}
          type="checkbox"
          role="switch"
          aria-describedby={f.describedBy}
          aria-invalid={error ? true : undefined}
          className={cx('peer sr-only', className)}
          {...rest}
        />
        <span
          aria-hidden="true"
          className={cx(
            'relative inline-block h-7 w-12 shrink-0 rounded-full border border-border-control bg-secondary',
            'transition-colors duration-(--duration-fast)',
            'after:absolute after:top-0.5 after:left-0.5 after:size-5 after:rounded-full after:bg-fg after:transition-transform after:duration-(--duration-fast) after:content-[""]',
            'peer-checked:border-accent peer-checked:bg-accent peer-checked:after:translate-x-5 peer-checked:after:bg-on-accent',
            'peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-focus',
            'peer-disabled:opacity-60',
          )}
        />
        {label}
      </label>
      <Notes hint={hint} hintId={f.hintId} error={error} errorId={f.errorId} />
    </div>
  );
}

function Notes({
  hint,
  hintId,
  error,
  errorId,
}: {
  hint?: string;
  hintId?: string;
  error?: string;
  errorId?: string;
}) {
  return (
    <>
      {hint ? (
        <p id={hintId} className="text-sm text-muted">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="text-sm font-medium text-danger-strong">
          {error}
        </p>
      ) : null}
    </>
  );
}

export interface ChoiceOption {
  value: string;
  /** Already through t(). */
  label: string;
  hint?: string;
  disabled?: boolean;
}

interface GroupProps extends LabelProps {
  options: readonly ChoiceOption[];
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
}

function Group({
  label,
  hint,
  error,
  className,
  children,
}: Pick<GroupProps, 'label' | 'hint' | 'error' | 'className'> & { children: ReactNode }) {
  const f = useField({ hint, error });
  return (
    <fieldset
      aria-describedby={f.describedBy}
      aria-invalid={error ? true : undefined}
      className={cx('flex min-w-0 flex-col gap-1 border-0 p-0', className)}
    >
      <legend className="mb-1 p-0 font-medium">{label}</legend>
      {children}
      <Notes hint={hint} hintId={f.hintId} error={error} errorId={f.errorId} />
    </fieldset>
  );
}

/** One question, several exclusive answers, all visible at once. Arrow keys move between them. */
export function RadioGroup({ options, value, onChange, disabled, ...group }: GroupProps) {
  const name = useId();
  return (
    <Group {...group}>
      {options.map((o) => (
        <label key={o.value} className="flex min-h-target cursor-pointer items-start gap-3 py-2.5">
          <input
            type="radio"
            name={name}
            value={o.value}
            checked={o.value === value}
            disabled={disabled || o.disabled}
            onChange={() => onChange(o.value)}
            className="mt-0.5 size-6 shrink-0 disabled:opacity-60"
          />
          <span className="flex flex-col">
            <span className="font-medium">{o.label}</span>
            {o.hint ? <span className="text-sm text-muted">{o.hint}</span> : null}
          </span>
        </label>
      ))}
    </Group>
  );
}

/** Two to five short exclusive options on one row (a view mode, a unit). Same semantics as RadioGroup. */
export function Segmented({ options, value, onChange, disabled, ...group }: GroupProps) {
  const name = useId();
  return (
    <Group {...group}>
      <div className="inline-flex w-fit max-w-full flex-wrap rounded-control border border-border-control bg-surface p-0.5">
        {options.map((o) => (
          <label key={o.value} className="relative flex cursor-pointer">
            <input
              type="radio"
              name={name}
              value={o.value}
              checked={o.value === value}
              disabled={disabled || o.disabled}
              onChange={() => onChange(o.value)}
              className="peer sr-only"
            />
            <span
              className={cx(
                'flex min-h-target min-w-16 items-center justify-center rounded-sm px-4 font-medium',
                'peer-checked:bg-primary peer-checked:text-on-primary',
                'peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-focus',
                'peer-disabled:opacity-60',
              )}
            >
              {o.label}
            </span>
          </label>
        ))}
      </div>
    </Group>
  );
}
