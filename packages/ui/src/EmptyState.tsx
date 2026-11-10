import type { ReactNode } from 'react';
import { Icon } from './Icon.tsx';
import type { IconDef } from './icons.ts';

/**
 * What a list shows when it has nothing in it. `title`, `description` and `action` are the
 * original contract. `icon` adds a glyph, `reason` says why the list is empty, and `secondary`
 * is one quiet extra link beside the main action.
 */
export function EmptyState({
  title,
  description,
  action,
  icon,
  reason,
  secondary,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  icon?: IconDef;
  /** One line on why this is empty, e.g. "Guests appear here after they join a line." */
  reason?: string;
  secondary?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-card border border-dashed border-border p-8 text-center">
      {icon ? (
        <span className="mb-1 grid size-14 place-items-center rounded-card bg-secondary text-primary">
          <Icon icon={icon} size="lg" className="size-7" />
        </span>
      ) : null}
      <p className="text-lg font-semibold">{title}</p>
      {description ? <p className="max-w-prose text-muted">{description}</p> : null}
      {reason ? <p className="max-w-prose text-sm text-muted">{reason}</p> : null}
      {action || secondary ? (
        <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
          {action}
          {secondary}
        </div>
      ) : null}
    </div>
  );
}
