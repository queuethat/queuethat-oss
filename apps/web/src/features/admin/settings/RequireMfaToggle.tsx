import { Checkbox } from '@qm/ui';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from '../../../lib/translation.tsx';
import { mfaStatusQuery } from '../../auth/mfa/api.ts';
import { requireMfaQuery, useSetRequireMfa } from './api.ts';

/**
 * "Require 2FA for owners and admins". Owners only, and disabled until their own session is aal2
 * (the database refuses otherwise, so an owner can't lock themselves out).
 */
export function RequireMfaToggle({ orgId, isOwner }: { orgId: string; isOwner: boolean }) {
  const { t } = useTranslation('auth');
  const required = useQuery(requireMfaQuery(orgId));
  const status = useQuery(mfaStatusQuery);
  const set = useSetRequireMfa(orgId);
  const aal2 = status.data?.level === 'aal2';
  const hint = !isOwner
    ? t('security.org.ownersOnly')
    : aal2
      ? t('security.org.hint')
      : t('security.org.needsCode');
  return (
    <Checkbox
      label={t('security.org.label')}
      hint={hint}
      error={set.error ? t('security.org.failed') : undefined}
      checked={required.data ?? false}
      disabled={!isOwner || !aal2 || required.isPending || set.isPending}
      onChange={(event) => set.mutate(event.target.checked)}
    />
  );
}
