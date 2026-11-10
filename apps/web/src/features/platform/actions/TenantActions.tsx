import { ConfirmDestructive, Input, Select } from '@qm/ui';
import { useState, type ReactNode } from 'react';
import { useTranslation } from '../../../lib/translation.tsx';
import type { OrgDetail } from '../api.ts';
import { formatWhen } from '../format.ts';
import {
  actionError,
  useBreakGlass,
  useRevokeDevices,
  useSetOrgStatus,
  useSignOutMembers,
  useTransferOwnership,
  type ActionResult,
} from './api.ts';

type ActionName = 'suspend' | 'restore' | 'transfer' | 'breakGlass' | 'signOut' | 'revokeDevices';

interface ConfirmedActionProps {
  name: ActionName;
  /** Names the result for tests. The suspend and restore rows share one, since one replaces the other. */
  id: string;
  /** What the person types to confirm: the org's join slug, or its name when it has none. */
  word: string;
  /** Anything else the action needs, and whether it is filled in. */
  extra?: ReactNode;
  extraReady?: boolean;
  disabled?: boolean;
  /** Said under the heading when `disabled`, so a dead button never goes unexplained. */
  disabledReason?: string;
  /** The last failure of the action's mutation. */
  error: Error | null;
  run: (reason: string) => Promise<ActionResult>;
  /** Says what the result's counts mean, e.g. "3 people signed out". */
  summary?: (counts: Record<string, number>) => string;
}

/**
 * One tenant action: what it does and what it doesn't, then a dialog that asks for a reason and
 * the org's slug typed back. Nothing is called until both are right and confirm is tapped. On
 * success it shows the audit row the database wrote.
 */
function ConfirmedAction({
  name,
  id,
  word,
  extra,
  extraReady = true,
  disabled,
  disabledReason,
  error,
  run,
  summary,
}: ConfirmedActionProps) {
  const { t, i18n } = useTranslation('platform');
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  const [result, setResult] = useState<ActionResult | null>(null);
  const ready = reason.trim() !== '' && typed.trim() === word.trim() && extraReady;
  const key = `actions.${name}` as const;

  const confirm = () => {
    if (!ready) return Promise.resolve();
    return run(reason.trim()).then(
      (done) => {
        setResult(done);
        setReason('');
        setTyped('');
      },
      () => {},
    );
  };

  return (
    <li className="flex flex-col gap-2 border-t border-border pt-4 first:border-t-0 first:pt-0">
      <h3 className="font-semibold">{t(`${key}.title`)}</h3>
      <p>{t(`${key}.effect`)}</p>
      {disabled && disabledReason ? <p className="text-fg-muted">{disabledReason}</p> : null}
      <div>
        <ConfirmDestructive
          triggerVariant={name === 'restore' ? 'secondary' : 'destructive'}
          triggerLabel={t(`${key}.trigger`)}
          title={t(`${key}.confirmTitle`)}
          description={t(`${key}.effect`)}
          confirmLabel={t(`${key}.confirm`)}
          cancelLabel={t('ops.cancel')}
          disabled={disabled}
          confirmDisabled={!ready}
          onConfirm={confirm}
        >
          <div className="flex flex-col gap-4">
            {extra}
            <Input
              label={t('actions.reason')}
              hint={t(`${key}.reasonHint`)}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={500}
              required
            />
            <Input
              label={t('actions.typeToConfirm', { word })}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              required
            />
          </div>
        </ConfirmDestructive>
      </div>
      <p role="alert" className="font-medium text-danger-strong empty:hidden">
        {error ? t(`actions.errors.${actionError(error)}`) : null}
      </p>
      {result ? (
        <p role="status" data-testid={`result-${id}`} className="font-medium">
          {summary ? `${summary(result.counts)} ` : null}
          {result.audit
            ? t('actions.recorded', {
                action: result.audit.action,
                at: formatWhen(result.audit.at, i18n.language, ''),
                reason: result.audit.reason ?? '',
              })
            : t('actions.nothingRecorded')}
        </p>
      ) : null}
    </li>
  );
}

/**
 * Tenant actions on the platform org detail (PLT12, #418): suspend or restore, transfer
 * ownership, break-glass, sign everyone out and revoke the screens. Only operators see them, and
 * the console only opens at aal2; the database enforces both again on every call. This page owns
 * no rule: it asks for a reason, calls the RPC and shows the audit row that came back.
 */
export function TenantActions({
  org,
  members,
}: {
  org: OrgDetail['org'];
  members: OrgDetail['members'];
}) {
  const { t } = useTranslation('platform');
  const status = useSetOrgStatus(org.id);
  const transfer = useTransferOwnership(org.id);
  const glass = useBreakGlass(org.id);
  const signOut = useSignOutMembers(org.id);
  const revoke = useRevokeDevices(org.id);
  const [newOwner, setNewOwner] = useState('');
  const word = org.slug ?? org.name;
  const owners = members.filter((m) => m.role === 'owner');
  const candidates = owners.length === 1 ? members.filter((m) => m.role !== 'owner') : members;
  const chosen = candidates.some((m) => m.email === newOwner)
    ? newOwner
    : (candidates[0]?.email ?? '');
  const pending = org.status === 'pending_deletion';
  const suspended = org.status === 'suspended';

  return (
    <section aria-labelledby="tenant-actions" className="flex flex-col gap-4">
      <h2 id="tenant-actions" className="text-xl font-semibold">
        {t('actions.title')}
      </h2>
      {pending ? (
        <p>{t('actions.pendingDeletion')}</p>
      ) : (
        <ul className="flex flex-col gap-4">
          <ConfirmedAction
            key="status"
            id="status"
            name={suspended ? 'restore' : 'suspend'}
            word={word}
            error={status.error}
            run={(reason) =>
              status.mutateAsync({ status: suspended ? 'active' : 'suspended', reason })
            }
          />
          <ConfirmedAction
            id="transfer"
            name="transfer"
            word={word}
            disabled={candidates.length === 0}
            disabledReason={t('actions.transfer.nobody')}
            extraReady={chosen !== ''}
            error={transfer.error}
            run={(reason) => transfer.mutateAsync({ email: chosen, reason })}
            extra={
              <Select
                label={t('actions.transfer.newOwner')}
                value={chosen}
                onChange={(e) => setNewOwner(e.target.value)}
              >
                {candidates.map((m) => (
                  <option key={m.user_id} value={m.email}>
                    {`${m.email} (${m.role})`}
                  </option>
                ))}
              </Select>
            }
          />
          <ConfirmedAction
            id="breakGlass"
            name="breakGlass"
            word={word}
            error={glass.error}
            run={(reason) => glass.mutateAsync({ reason })}
          />
          <ConfirmedAction
            id="signOut"
            name="signOut"
            word={word}
            error={signOut.error}
            run={(reason) => signOut.mutateAsync({ reason })}
            summary={(c) =>
              t('actions.signOut.done', {
                users: c.users ?? 0,
                sessions: c.sessions ?? 0,
                usersText: t('actions.people', { count: c.users ?? 0 }),
                sessionsText: t('actions.sessions', { count: c.sessions ?? 0 }),
              })
            }
          />
          <ConfirmedAction
            id="revokeDevices"
            name="revokeDevices"
            word={word}
            error={revoke.error}
            run={(reason) => revoke.mutateAsync({ reason })}
            summary={(c) => t('actions.revokeDevices.done', { count: c.devices ?? 0 })}
          />
        </ul>
      )}
    </section>
  );
}

/** What a support (read-only) role sees where the actions would be. */
export function TenantActionsReadOnly() {
  const { t } = useTranslation('platform');
  return (
    <section aria-labelledby="tenant-actions" className="flex flex-col gap-2">
      <h2 id="tenant-actions" className="text-xl font-semibold">
        {t('actions.title')}
      </h2>
      <p>{t('actions.operatorsOnly')}</p>
    </section>
  );
}
