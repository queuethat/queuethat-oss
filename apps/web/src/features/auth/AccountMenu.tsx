import { Button, Menu, type MenuItem } from '@qm/ui';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslation } from '../../lib/translation.tsx';
import { ContactSupportDialog } from '../admin/support/ContactSupport.tsx';
import { supportEmail } from '../marketing/company.ts';
import { useOperatorControls } from '../operator/OperatorChip.tsx';
import { useSession } from './api.ts';
import { SignOutButton } from './SignOutButton.tsx';

/**
 * One account menu for the admin header: switch operator, set my PIN (or lock, while a colleague
 * is working), change password and contact support. Sign out stays a button of its own. The buttons that used to sit in the
 * header row are only shown while a shared-tablet operator is in: "Working as …" and Lock.
 * Renders nothing when signed out.
 */
export function AccountMenu() {
  const { t } = useTranslation('auth');
  const { t: tc } = useTranslation('common');
  const navigate = useNavigate();
  const session = useSession();
  const op = useOperatorControls();
  const [contacting, setContacting] = useState(false);
  if (!session.data) return null;

  const items: MenuItem[] = [
    ...(op.ready
      ? [
          { id: 'switch', label: t('operator.switch'), onSelect: op.openSwitch },
          // set_my_pin refuses an operator token: a PIN changes only from the person's own login.
          op.operator
            ? { id: 'lock', label: t('operator.lock'), onSelect: op.lock }
            : { id: 'pin', label: t('operator.setPin'), onSelect: op.openPin },
        ]
      : []),
    {
      id: 'password',
      label: t('change.link'),
      onSelect: () => void navigate({ to: '/auth/change-password' }),
    },
    ...(supportEmail()
      ? [{ id: 'support', label: tc('contactSupport.button'), onSelect: () => setContacting(true) }]
      : []),
  ];

  return (
    <div className="flex items-center gap-2" data-testid="account-menu">
      {op.operator ? (
        <>
          <span className="font-medium" data-testid="operator-chip">
            {t('operator.chip', { name: op.operator.displayName ?? t('operator.unnamed') })}
          </span>
          <Button variant="secondary" onClick={op.lock}>
            {t('operator.lock')}
          </Button>
        </>
      ) : null}
      <Menu label={t('account.menu')} trigger={t('account.menu')} items={items} />
      <SignOutButton />
      {op.dialogs}
      <ContactSupportDialog open={contacting} onClose={() => setContacting(false)} />
    </div>
  );
}
