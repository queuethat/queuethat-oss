import { Badge, Card, Spinner } from '@qm/ui';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useTranslation } from '../../../lib/translation.tsx';
import { formatWhen } from '../format.ts';
import { taggedOrgsQuery } from './api.ts';

/**
 * Tenants whose notes carry `tag`: the Directory's tag filter. The "needs attention" list is the
 * console's single queue (attention/AttentionQueue), where churn-risk and billing-issue tags are
 * one reason among the others.
 */
export function TaggedTenants({ tag }: { tag: string }) {
  const { t, i18n } = useTranslation('platform');
  const tagged = useQuery(taggedOrgsQuery(tag));
  if (tagged.isError) return <p role="alert">{t('ops.loadFailed')}</p>;
  if (!tagged.data) return <Spinner label={t('notes.loading')} />;
  const rows = tagged.data;
  if (rows.length === 0) return <p>{t('notes.noTagged', { tag })}</p>;
  return (
    <Card className="flex flex-col gap-3" aria-label={t('notes.taggedTitle', { tag })}>
      <h2 className="text-xl font-semibold">{t('notes.taggedTitle', { tag })}</h2>
      <ul className="flex flex-col gap-2">
        {rows.map((org) => (
          <li
            key={org.org_id}
            data-testid="tagged-tenant"
            className="flex flex-wrap items-center gap-2"
          >
            <Link
              to="/platform/orgs/$orgId"
              params={{ orgId: org.org_id }}
              className="font-semibold underline"
            >
              {org.org_name}
            </Link>
            {org.tags.map((tg) => (
              <Badge key={tg} tone={org.needs_attention ? 'warning' : 'neutral'}>
                {tg}
              </Badge>
            ))}
            <span className="text-sm text-muted">
              {formatWhen(org.last_note_at, i18n.language, '')}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
