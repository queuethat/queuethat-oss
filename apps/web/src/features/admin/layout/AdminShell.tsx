import { AppShell } from '@qm/ui';
import { useState, type ReactNode } from 'react';
import { useTranslation } from '../../../lib/translation.tsx';
import { useModShortcuts } from '../../console/shortcuts/useShortcuts.ts';
import { SectionFrame } from '../tabs/SectionTabs.tsx';
import { AdminNav } from './AdminNav.tsx';
import { GoToPalette } from './GoToPalette.tsx';
import { useAdminNavGroups } from './navModel.ts';

/** The admin frame: sidebar or phone drawer with grouped navigation, and the Ctrl or Cmd + K palette. */
export function AdminShell({ children }: { children: ReactNode }) {
  const { t } = useTranslation('admin-nav');
  const [palette, setPalette] = useState(false);
  const groups = useAdminNavGroups();
  useModShortcuts(() => setPalette(true));
  return (
    <>
      <AppShell
        menuLabel={t('menu')}
        skipLabel={t('skip')}
        sidebarLabel={t('sidebar')}
        nav={({ close }) => (
          <AdminNav
            onNavigate={close}
            onOpenPalette={() => {
              close();
              setPalette(true);
            }}
          />
        )}
      >
        <SectionFrame>{children}</SectionFrame>
      </AppShell>
      <GoToPalette open={palette} onClose={() => setPalette(false)} groups={groups} />
    </>
  );
}
