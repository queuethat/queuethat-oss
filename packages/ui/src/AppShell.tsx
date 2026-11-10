import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Button } from './Button.tsx';

export interface AppShellProps {
  /** The navigation. A function receives `close` so a link tap can dismiss the phone drawer. */
  nav: ReactNode | ((api: { close: () => void }) => ReactNode);
  /** Label of the phone menu button; pass through t(). */
  menuLabel: string;
  /** Label of the skip link that jumps to the page content; pass through t(). */
  skipLabel: string;
  /** Accessible name of the sidebar region (`complementary`); pass through t(). */
  sidebarLabel: string;
  children: ReactNode;
}

/**
 * Page frame for the admin area: a sidebar from 1024px up, a drawer behind a menu button below,
 * and the page in `<main>`. Landmarks: skip link, `complementary` sidebar (holding the nav), `main`.
 * Escape closes the drawer and returns focus to its button. Pages put a `PageHeader` first.
 */
export function AppShell({ nav, menuLabel, skipLabel, sidebarLabel, children }: AppShellProps) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const close = () => setOpen(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <div className="flex flex-col gap-2 lg:flex-row lg:gap-6 print:block">
      <a
        href="#main-content"
        className="fixed top-0 left-4 z-50 inline-flex min-h-target -translate-y-full items-center rounded-control bg-surface px-4 text-fg focus:translate-y-2"
      >
        {skipLabel}
      </a>
      <aside aria-label={sidebarLabel} className="lg:w-64 lg:shrink-0 print:hidden">
        <Button
          ref={button}
          variant="secondary"
          className="lg:hidden"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((o) => !o)}
        >
          {menuLabel}
        </Button>
        <div id={id} className={`${open ? 'block' : 'hidden'} mt-2 lg:mt-0 lg:block`}>
          {typeof nav === 'function' ? nav({ close }) : nav}
        </div>
      </aside>
      <main id="main-content" tabIndex={-1} className="w-full min-w-0 flex-1 outline-none">
        {children}
      </main>
    </div>
  );
}
