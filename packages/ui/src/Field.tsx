import {
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { cx } from './cx.ts';

interface FieldProps {
  /** Visible label. Every control has one; placeholders are not labels. */
  label: string;
  hint?: string;
  /** Shown below the control and announced; also sets aria-invalid. */
  error?: string;
}

export const control =
  'block min-h-target rounded-control border border-border-control bg-surface px-3 text-base ' +
  'text-fg aria-invalid:border-danger disabled:opacity-60';

export function useField({ hint, error }: Omit<FieldProps, 'label'>) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  return {
    id,
    hintId,
    errorId,
    describedBy: [hintId, errorId].filter(Boolean).join(' ') || undefined,
  };
}

export function FieldShell({
  id,
  label,
  hint,
  hintId,
  error,
  errorId,
  children,
}: FieldProps & { id: string; hintId?: string; errorId?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="font-medium">
        {label}
      </label>
      {children}
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
    </div>
  );
}

export type InputProps = FieldProps & InputHTMLAttributes<HTMLInputElement>;

/** Labelled text input with optional hint and error. */
export function Input({ label, hint, error, className, ...rest }: InputProps) {
  const f = useField({ hint, error });
  return (
    <FieldShell {...{ id: f.id, label, hint, hintId: f.hintId, error, errorId: f.errorId }}>
      <input
        id={f.id}
        aria-describedby={f.describedBy}
        aria-invalid={error ? true : undefined}
        className={cx(control, 'w-full', className)}
        {...rest}
      />
    </FieldShell>
  );
}

export type TextareaProps = FieldProps & TextareaHTMLAttributes<HTMLTextAreaElement>;

/** Labelled multi-line text input with optional hint and error. */
export function Textarea({ label, hint, error, className, ...rest }: TextareaProps) {
  const f = useField({ hint, error });
  return (
    <FieldShell {...{ id: f.id, label, hint, hintId: f.hintId, error, errorId: f.errorId }}>
      <textarea
        id={f.id}
        aria-describedby={f.describedBy}
        aria-invalid={error ? true : undefined}
        className={cx(control, 'min-h-24 w-full py-2', className)}
        {...rest}
      />
    </FieldShell>
  );
}

export type SelectProps = FieldProps & SelectHTMLAttributes<HTMLSelectElement>;

/**
 * A native select drawn by us. Safari on macOS ignores min-height on a select it draws itself
 * (23px instead of 48, #503), so `appearance: none` hands sizing to the stylesheet and this
 * draws the chevron the platform would have. Used by Select and the PhoneInput country picker.
 */
export function SelectControl({
  className,
  wrapperClassName,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & { wrapperClassName?: string }) {
  return (
    <span className={cx('relative block', wrapperClassName)}>
      <select
        className={cx(control, 'w-full appearance-none overflow-hidden pr-10', className)}
        {...rest}
      />
      <svg
        aria-hidden="true"
        viewBox="0 0 20 20"
        className="pointer-events-none absolute top-1/2 right-3 size-5 -translate-y-1/2 text-muted"
      >
        <path
          d="M5 7.5l5 5 5-5"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

/** Labelled native select: the platform picker is the most usable one on phones and kiosks. */
export function Select({ label, hint, error, className, children, ...rest }: SelectProps) {
  const f = useField({ hint, error });
  return (
    <FieldShell {...{ id: f.id, label, hint, hintId: f.hintId, error, errorId: f.errorId }}>
      <SelectControl
        id={f.id}
        aria-describedby={f.describedBy}
        aria-invalid={error ? true : undefined}
        className={className}
        {...rest}
      >
        {children}
      </SelectControl>
    </FieldShell>
  );
}

export type CheckboxProps = FieldProps & Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>;

/** Labelled checkbox. The whole row is the hit target, so it stays at least 48px tall. */
export function Checkbox({ label, hint, error, className, ...rest }: CheckboxProps) {
  const f = useField({ hint, error });
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={f.id} className="flex min-h-target items-center gap-3 font-medium">
        <input
          id={f.id}
          type="checkbox"
          aria-describedby={f.describedBy}
          aria-invalid={error ? true : undefined}
          className={cx('size-6 disabled:opacity-60', className)}
          {...rest}
        />
        {label}
      </label>
      {hint ? (
        <p id={f.hintId} className="text-sm text-muted">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={f.errorId} className="text-sm font-medium text-danger-strong">
          {error}
        </p>
      ) : null}
    </div>
  );
}
