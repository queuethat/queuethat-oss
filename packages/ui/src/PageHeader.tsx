import type { ReactNode } from 'react';
import { cx } from './cx.ts';

export interface Crumb {
  label: string;
  /** Rendered through `renderCrumb`; the last crumb is the current page and is not a link. */
  to?: string;
}

export interface PageHeaderProps {
  /** The page's single `<h1>`; pass through t(). */
  title: string;
  description?: ReactNode;
  /** The page's primary action(s), right-aligned from 640px up. */
  actions?: ReactNode;
  /** Ancestors of this page, outermost first. Only for nested pages. */
  breadcrumbs?: Crumb[];
  /** Accessible name of the breadcrumb landmark; required with `breadcrumbs`. */
  breadcrumbLabel?: string;
  /** Renders a crumb that has `to`, so the kit stays router-free. */
  renderCrumb?: (crumb: Crumb & { to: string }) => ReactNode;
  className?: string;
}

/**
 * Title block for an admin page: breadcrumbs when nested, the one `<h1>`, a description and the
 * primary action. Replaces the per-page `<h1 className="text-2xl ...">` row.
 */
export function PageHeader({
  title,
  description,
  actions,
  breadcrumbs,
  breadcrumbLabel,
  renderCrumb,
  className,
}: PageHeaderProps) {
  return (
    <header className={cx('flex flex-col gap-2', className)}>
      {breadcrumbs?.length ? (
        <nav aria-label={breadcrumbLabel}>
          <ol className="flex flex-wrap items-center gap-x-2 text-sm text-muted">
            {breadcrumbs.map((crumb, i) => (
              <li key={`${i}-${crumb.label}`} className="flex items-center gap-2">
                {crumb.to && renderCrumb ? renderCrumb({ ...crumb, to: crumb.to }) : crumb.label}
                <span aria-hidden="true">/</span>
              </li>
            ))}
          </ol>
        </nav>
      ) : null}
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          {description ? <p className="mt-1 max-w-prose text-muted">{description}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-3">{actions}</div> : null}
      </div>
    </header>
  );
}
