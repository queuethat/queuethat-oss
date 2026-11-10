import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { buttonBase, buttonVariants, type ButtonVariant } from './Button.tsx';
import { cx } from './cx.ts';

export interface LinkButtonRenderProps {
  className: string;
  children: ReactNode;
}

export interface LinkButtonProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'children'> {
  variant?: ButtonVariant;
  children: ReactNode;
  /**
   * Render the element yourself so the router's link can be used, e.g.
   * `render={(p) => <Link to="/admin" {...p} />}`. Without it a plain `<a href>` is rendered.
   */
  render?: (props: LinkButtonRenderProps) => ReactNode;
}

/**
 * A link that looks and sizes like `Button` (at least 48px tall, S-11). Router-agnostic: pass
 * `render` to supply the router's link component. Use it for navigation; use `Button` for actions.
 */
export function LinkButton({
  variant = 'primary',
  className,
  children,
  render,
  ...rest
}: LinkButtonProps) {
  const cls = cx(buttonBase, buttonVariants[variant], 'min-h-target px-4 text-base', className);
  if (render) return <>{render({ className: cls, children })}</>;
  return (
    <a className={cls} {...rest}>
      {children}
    </a>
  );
}
