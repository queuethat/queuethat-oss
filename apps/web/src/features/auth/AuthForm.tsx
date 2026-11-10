import { Mark } from '@qm/ui';
import { useTranslation } from '../../lib/translation.tsx';
import type { FormEvent, ReactNode } from 'react';
import { AuthPanel, type AuthPanelKind } from './AuthPanel.tsx';

/**
 * The shell every auth screen sits in: wordmark, heading, an announced error, the form and a
 * footer on one side, and a decorative panel (static art, no data) on wide screens.
 */
export function AuthCard({
  title,
  error,
  children,
  footer,
  panel = 'ticket',
}: {
  title: string;
  error?: string | undefined;
  children: ReactNode;
  footer?: ReactNode;
  panel?: AuthPanelKind;
}) {
  const { t } = useTranslation('auth');
  return (
    <div className="grid min-h-screen lg:h-screen lg:grid-cols-2">
      <div className="flex flex-col justify-between gap-8 px-5 py-6 sm:px-10 lg:overflow-y-auto">
        <p className="flex items-center gap-3 text-2xl font-semibold tracking-[-0.03em]">
          <Mark size={36} />
          <span>{t('shell.brand')}</span>
        </p>
        <div className="mx-auto flex w-full max-w-sm flex-col gap-4">
          <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
          {/* Always mounted so screen readers announce an error when it appears. */}
          <p role="alert" className="text-danger-strong font-medium empty:hidden">
            {error}
          </p>
          {children}
          {footer ? <div className="text-sm">{footer}</div> : null}
        </div>
        <p className="text-sm text-muted">{t('shell.copyright')}</p>
      </div>
      <AuthPanel kind={panel} />
    </div>
  );
}

/** Reads the email and password inputs of a submitted auth form. */
export function readCredentials(event: FormEvent<HTMLFormElement>) {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  return {
    email: String(data.get('email') ?? '').trim(),
    password: String(data.get('password') ?? ''),
  };
}
