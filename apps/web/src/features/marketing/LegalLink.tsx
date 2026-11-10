import type { ReactNode } from 'react';

/** A link to a page on the marketing site (queuethat.com). */
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
