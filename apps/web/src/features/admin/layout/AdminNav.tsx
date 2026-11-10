import { Button, Icon, iconSearch, SectionNav } from '@qm/ui';
import { Link, useRouterState } from '@tanstack/react-router';
import { useTranslation } from '../../../lib/translation.tsx';
import { currentItemId, sidebarGroups, useAdminNavGroups } from './navModel.ts';

/**
 * Admin navigation: Run (open), then Team, Set up, Insights and Account (collapsed), Danger zone
 * last, and the "Go to…" button. The group holding the current page is open; other choices are
 * remembered per browser. `AdminShell` supplies the sidebar or phone drawer around it.
 */
export function AdminNav({
  onNavigate,
  onOpenPalette,
}: {
  onNavigate: () => void;
  onOpenPalette: () => void;
}) {
  const { t } = useTranslation('admin-nav');
  const groups = useAdminNavGroups();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return (
    <div className="flex flex-col gap-2 print:hidden">
      <Button variant="secondary" className="w-full justify-start" onClick={onOpenPalette}>
        <Icon icon={iconSearch} />
        {t('goTo.button')}
        <kbd className="ml-auto rounded border border-border px-1.5 font-mono text-xs text-muted">
          {t('goTo.shortcut')}
        </kbd>
      </Button>
      <SectionNav
        label={t('label')}
        groups={sidebarGroups(groups)}
        storageKey="qm-admin-nav"
        currentId={currentItemId(groups, pathname)}
        renderItem={(item, view) => (
          <Link
            to={item.to}
            activeOptions={{ exact: true }}
            aria-current={view.current ? 'page' : undefined}
            className={view.className}
            onClick={onNavigate}
          >
            {view.content}
          </Link>
        )}
      />
    </div>
  );
}
