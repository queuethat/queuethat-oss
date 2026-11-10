import type { ButtonHTMLAttributes, Ref } from 'react';
import { cx } from './cx.ts';
import { Spinner } from './Spinner.tsx';

/** `quiet` is for utility actions beside a primary one: no fill until hovered. */
export type ButtonVariant = 'primary' | 'secondary' | 'destructive' | 'quiet';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  /** Disables the button and shows a spinner; `loadingLabel` is what screen readers hear. */
  loading?: boolean;
  loadingLabel?: string;
  ref?: Ref<HTMLButtonElement>;
}

export const buttonVariants: Record<ButtonVariant, string> = {
  primary: 'bg-primary text-on-primary hover:bg-primary-hover',
  secondary: 'bg-secondary text-on-secondary hover:bg-secondary-hover',
  destructive: 'bg-danger text-on-danger hover:bg-danger-hover',
  quiet: 'bg-transparent text-on-secondary hover:bg-secondary',
};

export const buttonBase =
  'inline-flex items-center justify-center gap-2 rounded-control font-semibold select-none ' +
  'transition-colors disabled:cursor-not-allowed disabled:opacity-60';

/**
 * The only button apps may render (raw `<button>` is lint-banned in features). Always at least
 * 48px tall (S-11) and `type="button"` unless told otherwise, so it never submits by accident.
 */
export function Button({
  variant = 'primary',
  loading = false,
  loadingLabel,
  disabled,
  className,
  children,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx(buttonBase, buttonVariants[variant], 'min-h-target px-4 text-base', className)}
      {...rest}
    >
      {loading ? <Spinner label={loadingLabel ?? ''} /> : null}
      {children}
    </button>
  );
}

/** Staff console and kiosk: at least 56px tall and full width by default. */
export function BigButton({ className, ...rest }: ButtonProps) {
  return <Button className={cx('min-h-target-big w-full px-6 text-lg', className)} {...rest} />;
}
