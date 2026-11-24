// SPDX-License-Identifier: LicenseRef-QueueThat-EE
import { LinkButton } from '@qm/ui';
import { Link } from '@tanstack/react-router';
import { useTranslation } from '@app/lib/translation.tsx';

/** Slot `guests.actions`: the guest-list tools next to the Guests page's own buttons. */
export default function GuestsActions({ role }: { role: string }) {
  const { t } = useTranslation('crm');
  return (
    <>
      {role === 'owner' || role === 'admin' || role === 'manager' ? (
        <LinkButton
          variant="secondary"
          render={(p) => <Link to="/admin/x/guests-duplicates" {...p} />}
        >
          {t('actions.duplicates')}
        </LinkButton>
      ) : null}
      {role === 'owner' || role === 'admin' ? (
        <LinkButton variant="secondary" render={(p) => <Link to="/admin/x/guests-import" {...p} />}>
          {t('actions.importExport')}
        </LinkButton>
      ) : null}
    </>
  );
}
