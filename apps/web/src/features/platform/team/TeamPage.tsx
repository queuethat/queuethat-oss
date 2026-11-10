import { Badge, EmptyState, PageHeader, Spinner } from '@qm/ui';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from '../../../lib/translation.tsx';
import { platformTeamQuery } from './api.ts';

/**
 * `/platform/team` (#1134): who holds a platform role, whether they have two-step sign-in, and
 * when they last signed in. Read-only on purpose: roles are granted and removed with the command
 * line (`pnpm platform:grant` / `platform:revoke`), never from this console.
 */
export function TeamPage() {
  const { t, i18n } = useTranslation('platform');
  const team = useQuery(platformTeamQuery);
  const time = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' });
  const day = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium' });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('team.title')} />
      <p className="text-muted">{t('team.intro')}</p>
      {!team.data ? (
        team.isError ? (
          <EmptyState
            title={
              team.error.message === 'permission_denied' ? t('team.denied') : t('ops.loadFailed')
            }
          />
        ) : (
          <Spinner label={t('ops.loading')} />
        )
      ) : team.data.length === 0 ? (
        <EmptyState title={t('team.none')} />
      ) : (
        <table className="w-full text-left">
          <thead>
            <tr>
              <th scope="col">{t('team.email')}</th>
              <th scope="col">{t('team.role')}</th>
              <th scope="col">{t('team.mfa')}</th>
              <th scope="col">{t('team.lastSignIn')}</th>
              <th scope="col">{t('team.grantedBy')}</th>
              <th scope="col">{t('team.grantedAt')}</th>
            </tr>
          </thead>
          <tbody>
            {team.data.map((m) => (
              <tr key={m.user_id} data-testid="team-member">
                <td>
                  {m.email}
                  {m.is_you ? <Badge>{t('team.you')}</Badge> : null}
                </td>
                <td>{t(`team.roles.${m.role}`)}</td>
                <td>
                  {m.mfa_enrolled ? (
                    <Badge tone="success">{t('team.mfaOn')}</Badge>
                  ) : (
                    <Badge tone="danger">{t('team.mfaOff')}</Badge>
                  )}
                </td>
                <td>
                  {m.last_sign_in_at ? time.format(new Date(m.last_sign_in_at)) : t('team.never')}
                </td>
                <td>{m.granted_by_email ?? t('team.viaCli')}</td>
                <td>{day.format(new Date(m.granted_at))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
