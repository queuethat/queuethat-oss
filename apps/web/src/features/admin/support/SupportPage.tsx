import {
  Badge,
  Button,
  ConfirmDestructive,
  EmptyState,
  Input,
  PageHeader,
  Select,
  Skeleton,
} from '@qm/ui';
import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from '../../../lib/translation.tsx';
import { useNow } from '../../../lib/now.ts';
import { useCurrentOrg } from '../../auth/current.ts';
import {
  liveGrants,
  supportGrantsQuery,
  useChangeSupportAccess,
  type SupportGrant,
  type SupportScope,
} from './api.ts';
import { useFormat } from './format.ts';
import { HelpArticles } from './HelpArticles.tsx';

const KNOWN_ERRORS = ['permission_denied', 'invalid_input'];

/**
 * `/admin/settings/support` (PLT14, #420): owners grant and end support access; every member sees
 * the live grant and the history, break-glass included. The database decides who may change it.
 */
export function SupportPage() {
  const { t } = useTranslation('admin');
  const org = useCurrentOrg();
  const grants = useQuery({ ...supportGrantsQuery(org?.id ?? ''), enabled: !!org });
  if (!org || !grants.data) return <Skeleton label={t('support.loading')} rows={2} />;
  const isOwner = org.role === 'owner';
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 pb-8">
      <PageHeader
        title={t('support.title')}
        description={
          <>
            {t('support.intro')}
            {isOwner ? null : <span className="block">{t('support.ownersOnly')}</span>}
          </>
        }
      />
      <Access orgId={org.id} grants={grants.data} isOwner={isOwner} />
      <History grants={grants.data} />
      <HelpArticles />
    </div>
  );
}

function Access({
  orgId,
  grants,
  isOwner,
}: {
  orgId: string;
  grants: SupportGrant[];
  isOwner: boolean;
}) {
  const { t } = useTranslation('admin');
  const change = useChangeSupportAccess(orgId);
  const [scope, setScope] = useState<SupportScope>('read');
  const [hours, setHours] = useState('4');
  const [reason, setReason] = useState('');
  const live = liveGrants(grants, useNow(15_000));
  const format = useFormat();
  const failure = change.error
    ? `support.errors.${KNOWN_ERRORS.includes(change.error.message) ? change.error.message : 'unknown'}`
    : null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    change.mutate(
      { kind: 'grant', scope, hours: Number(hours), reason },
      { onSuccess: () => setReason('') },
    );
  };

  return (
    <section className="flex flex-col gap-4" aria-labelledby="support-now">
      <h2 id="support-now" className="text-xl font-semibold">
        {t('support.now.title')}
      </h2>
      {live.length === 0 ? (
        <p data-testid="support-status">{t('support.now.none')}</p>
      ) : (
        <ul className="flex flex-col gap-2" data-testid="support-status">
          {live.map((g) => (
            <li key={g.id}>
              {t(`support.now.${g.break_glass ? 'breakGlass' : g.scope}`, {
                until: format(g.expires_at),
              })}
            </li>
          ))}
        </ul>
      )}
      {isOwner && live.length > 0 ? (
        <div>
          <ConfirmDestructive
            triggerLabel={t('support.revoke.trigger')}
            title={t('support.revoke.title')}
            description={t('support.revoke.description')}
            confirmLabel={t('support.revoke.confirm')}
            cancelLabel={t('support.revoke.cancel')}
            onConfirm={() => change.mutateAsync({ kind: 'revoke' }).catch(() => {})}
          />
        </div>
      ) : null}
      <p role="alert" className="font-medium text-danger-strong empty:hidden">
        {failure ? t(failure as 'support.errors.unknown') : null}
      </p>
      {isOwner ? (
        <form className="flex flex-col gap-4" onSubmit={submit}>
          <h3 className="text-lg font-semibold">{t('support.grant.title')}</h3>
          <div className="flex flex-wrap gap-3">
            <Select
              label={t('support.grant.scope')}
              value={scope}
              onChange={(event) => setScope(event.target.value as SupportScope)}
            >
              <option value="read">{t('support.scope.read')}</option>
              <option value="act">{t('support.scope.act')}</option>
            </Select>
            <Input
              label={t('support.grant.hours')}
              hint={t('support.grant.hoursHint')}
              type="number"
              inputMode="numeric"
              min={1}
              max={72}
              required
              value={hours}
              onChange={(event) => setHours(event.target.value)}
            />
          </div>
          <Input
            label={t('support.grant.reason')}
            hint={t('support.grant.reasonHint')}
            required
            maxLength={500}
            pattern=".*\S.*"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
          <div>
            <Button
              type="submit"
              loading={change.isPending}
              loadingLabel={t('support.grant.saving')}
            >
              {t(
                live.some((g) => !g.break_glass) ? 'support.grant.replace' : 'support.grant.submit',
              )}
            </Button>
          </div>
        </form>
      ) : null}
    </section>
  );
}

function History({ grants }: { grants: SupportGrant[] }) {
  const { t } = useTranslation('admin');
  const format = useFormat();
  const now = useNow(15_000);
  return (
    <section className="flex flex-col gap-3" aria-labelledby="support-history">
      <h2 id="support-history" className="text-xl font-semibold">
        {t('support.history.title')}
      </h2>
      {grants.length === 0 ? (
        <EmptyState title={t('support.history.empty')} />
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {grants.map((g) => (
            <li key={g.id} className="flex flex-col gap-1 py-3" data-testid="support-grant">
              <p className="flex flex-wrap items-center gap-2 font-semibold">
                {g.break_glass ? (
                  <Badge tone="danger">{t('support.history.breakGlass')}</Badge>
                ) : null}
                {t(`support.scope.${g.scope}`)} · {format(g.created_at)}
              </p>
              <p>{t('support.history.reason', { reason: g.reason })}</p>
              <p className="text-muted">
                {g.revoked_at
                  ? t('support.history.revoked', { at: format(g.revoked_at) })
                  : Date.parse(g.expires_at) > now
                    ? t('support.history.ends', { at: format(g.expires_at) })
                    : t('support.history.expired', { at: format(g.expires_at) })}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
