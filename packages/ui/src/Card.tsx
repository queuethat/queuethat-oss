import type { HTMLAttributes } from 'react';
import { cx } from './cx.ts';

/** Surface for grouping content: a visit row, a queue summary, a form. */
export function Card({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cx('rounded-card border border-border bg-surface p-4 text-fg', className)}
      {...rest}
    />
  );
}
