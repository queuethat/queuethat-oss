import type { ReactNode } from 'react';

/** A link to one of the operator's legal pages (features/marketing/company.ts). */
export function LegalLink({
  href,
  className,
  children,
}: {
  href: string;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <a href={href} className={className}>
      {children}
    </a>
  );
}
