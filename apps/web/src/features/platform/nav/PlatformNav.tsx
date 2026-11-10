import { Link, useRouterState } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';
import { useTranslation } from '../../../lib/translation.tsx';
import {
  currentNavKey,
  platformNavGroups,
  type PlatformNavItem,
  type PlatformRole,
} from './platformNav.ts';

const PILL =
  'inline-flex min-h-target items-center rounded-control px-4 font-semibold transition-colors';
const LOOK = {
  on: 'bg-primary text-on-primary',
  off: 'bg-secondary text-on-secondary hover:bg-secondary-hover',
};

function NavLink({
  item,
  current,
  label,
}: {
  item: PlatformNavItem;
  current: boolean;
  label: string;
}) {
  const ref = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    if (current) ref.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [current]);
  const props = {
    ref,
    activeOptions: { exact: true },
    'aria-current': current ? ('page' as const) : ('false' as const),
    className: `${PILL} ${current ? LOOK.on : LOOK.off}`,
  };
  return item.link.to === '/platform/$' ? (
    <Link to="/platform/$" params={item.link.params} {...props}>
      {label}
    </Link>
  ) : (
    <Link to={item.link.to} {...props}>
      {label}
    </Link>
  );
}

/**
 * The console's navigation: every page, grouped into customers, operations and oversight, with
 * the current page marked. On a phone each group is one row that scrolls sideways.
 */
export function PlatformNav({ role }: { role: PlatformRole }) {
  const { t } = useTranslation('platform');
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const current = currentNavKey(pathname);
  return (
    <nav aria-label={t('nav.label')}>
      <ul className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:gap-x-8">
        {platformNavGroups(role).map((group) => (
          <li key={group.id} className="flex min-w-0 items-center gap-x-3 sm:flex-wrap sm:gap-y-2">
            <span
              id={`platform-nav-${group.id}`}
              className="shrink-0 text-sm font-semibold text-muted"
            >
              {t(`nav.groups.${group.id}`)}
            </span>
            <ul
              aria-labelledby={`platform-nav-${group.id}`}
              className="flex min-w-0 gap-2 overflow-x-auto sm:flex-wrap sm:overflow-visible"
            >
              {group.items.map((item) => (
                <li key={item.key} className="shrink-0">
                  <NavLink
                    item={item}
                    current={item.key === current}
                    label={t(`nav.${item.key}`)}
                  />
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </nav>
  );
}
