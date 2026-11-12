import {
  Badge,
  Button,
  Checkbox,
  ConfirmDestructive,
  Dialog,
  EmptyState,
  Input,
  PageHeader,
  RadioGroup,
  Select,
  Skeleton,
  useToast,
} from '@qm/ui';
import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import { useTranslation } from '../../../lib/translation.tsx';
import { ScreenEmpty } from '../../../components/ScreenEmpty.tsx';
import { useSession } from '../../auth/api.ts';
import { ExtensionSlot } from '../../../extensions/ExtensionSlot.tsx';
import { isLimitReached, limitOf } from '../limits.ts';
import { useCurrentLocation, useCurrentOrg } from '../../auth/current.ts';
import {
  customRolesQuery,
  memberRolesQuery,
  useAssignRole,
  type CustomRole,
} from '../roles/api.ts';
import {
  canManageRole,
  canManageTeam,
  grantablePresets,
  invitationsQuery,
  membersQuery,
  useInviteStaff,
  useRemoveMember,
  useResendInvitation,
  useRevokeInvitation,
  useSetMemberRole,
  type Member,
  type MemberRole,
} from './api.ts';
import { memberLinesQuery, scopeStaffQuery, useSetMemberLines } from './lines/api.ts';
import { LinePicker, ScopeStaffSetting } from './lines/LinesUi.tsx';

const KNOWN_ERRORS = [
  'forbidden_role',
  'last_owner',
  'permission_denied',
  'invalid_input',
  'rate_limited',
  'send_failed',
  'org_suspended',
  'not_found',
];

/** The translation key for a failed team action. */
function errorKey(error: Error | null) {
  if (!error) return null;
  return `errors.${KNOWN_ERRORS.includes(error.message) ? error.message : 'unknown'}` as 'errors.unknown';
}

/** Who is on the team, who is invited, and how to change either (2A-TM3, #97). */
export function TeamPage() {
  const { t } = useTranslation('admin-team');
  const org = useCurrentOrg();
  if (!org) return <Skeleton label={t('loading')} rows={2} />;
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 pb-8">
      <PageHeader
        title={t('title')}
        description={canManageTeam(org.role) ? undefined : t('readOnly')}
      />
      <Members orgId={org.id} role={org.role} />
      {canManageTeam(org.role) ? <ScopeStaffSetting orgId={org.id} canEdit /> : null}
      {canManageTeam(org.role) ? <Pending orgId={org.id} role={org.role} /> : null}
    </div>
  );
}

function useOrgLocations(orgId: string) {
  return useCurrentLocation().locations.filter((l) => l.org_id === orgId);
}

/** One question with the three presets; Admin and everything finer sits in {@link Advanced}. */
function PresetPicker({
  actor,
  value,
  onChange,
  label,
}: {
  actor: string;
  value: MemberRole;
  onChange: (role: MemberRole) => void;
  label: string;
}) {
  const { t } = useTranslation('admin-team');
  return (
    <RadioGroup
      label={label}
      value={value}
      onChange={(role) => onChange(role as MemberRole)}
      options={grantablePresets(actor).map((p) => ({
        value: p.role,
        label: t(`preset.${p.preset}`),
        hint: t(`preset.help.${p.preset}`),
      }))}
    />
  );
}

/** Admin access, for owners only: it is not one of the three presets. */
function AdminOption({
  actor,
  role,
  onChange,
}: {
  actor: string;
  role: MemberRole;
  onChange: (role: MemberRole) => void;
}) {
  const { t } = useTranslation('admin-team');
  if (!canManageRole(actor, 'admin')) return null;
  return (
    <Checkbox
      label={t('advanced.admin')}
      hint={t('advanced.adminHint')}
      checked={role === 'admin'}
      onChange={(event) => onChange(event.target.checked ? 'admin' : 'staff')}
    />
  );
}

/** Rare choices stay folded away so the common path is email plus one preset. */
function Advanced({ open, children }: { open?: boolean; children: ReactNode }) {
  const { t } = useTranslation('admin-team');
  return (
    <details open={open} className="flex flex-col gap-4">
      <summary className="min-h-target cursor-pointer py-3 font-medium">
        {t('advanced.title')}
      </summary>
      <div className="flex flex-col gap-4">{children}</div>
    </details>
  );
}

function LocationPicker({
  orgId,
  value,
  onChange,
  label,
  allLabel,
}: {
  orgId: string;
  value: string[] | null;
  onChange: (next: string[] | null) => void;
  label: string;
  allLabel: string;
}) {
  const locations = useOrgLocations(orgId);
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="font-medium">{label}</legend>
      <Checkbox label={allLabel} checked={value === null} onChange={() => onChange(null)} />
      {locations.map((l) => (
        <Checkbox
          key={l.id}
          label={l.name}
          checked={value?.includes(l.id) ?? false}
          onChange={(event) => {
            const current = value ?? [];
            const next = event.target.checked
              ? [...current, l.id]
              : current.filter((id) => id !== l.id);
            onChange(next);
          }}
        />
      ))}
    </fieldset>
  );
}

function Members({ orgId, role }: { orgId: string; role: string }) {
  const { t } = useTranslation('admin-team');
  const me = useSession().data?.user.id;
  const locations = useOrgLocations(orgId);
  const members = useQuery(membersQuery(orgId));
  const roles = useQuery({ ...customRolesQuery(orgId), enabled: canManageTeam(role) });
  const held = useQuery({ ...memberRolesQuery(orgId), enabled: canManageTeam(role) });
  if (!members.data) return <Skeleton label={t('loading')} rows={2} />;
  return (
    <section className="flex flex-col gap-3" aria-labelledby="members-heading">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="members-heading" className="text-xl font-semibold">
          {t('members.title')}
        </h2>
        {canManageTeam(role) ? <InviteDialog orgId={orgId} role={role} /> : null}
      </div>
      <ul className="flex flex-col divide-y divide-border">
        {members.data.map((m) => {
          const name = m.displayName ?? m.email ?? t('members.noName');
          const places =
            m.locationIds === null
              ? t('members.allLocations')
              : m.locationIds.length === 1
                ? (locations.find((l) => l.id === m.locationIds![0])?.name ??
                  t('members.someLocations', { count: 1 }))
                : t('members.someLocations', { count: m.locationIds.length });
          const manageable = canManageRole(role, m.role) && m.userId !== me;
          return (
            <li
              key={m.id}
              className="flex flex-wrap items-center justify-between gap-3 py-3"
              data-testid="member"
            >
              <div className="flex flex-col gap-1">
                <p className="font-semibold">
                  {name}{' '}
                  {m.userId === me ? (
                    <span className="font-normal text-muted">{t('members.you')}</span>
                  ) : null}
                </p>
                <p className="flex flex-wrap items-center gap-2 text-muted">
                  <Badge tone="info">{t(`role.${m.role}`)}</Badge>
                  {roles.data?.find((r) => r.id === held.data?.[m.id]) ? (
                    <Badge tone="neutral">
                      {roles.data.find((r) => r.id === held.data?.[m.id])!.name}
                    </Badge>
                  ) : null}
                  {m.email && m.displayName ? `${m.email} · ` : null}
                  {places}
                  {m.hasPin ? ` · ${t('members.pin')}` : null}
                </p>
              </div>
              {manageable ? (
                <div className="flex flex-wrap gap-2">
                  <EditMember
                    orgId={orgId}
                    actorRole={role}
                    member={m}
                    name={name}
                    customRoles={roles.data ?? []}
                    customRoleId={held.data?.[m.id] ?? null}
                  />
                  <RemoveMember orgId={orgId} member={m} name={name} />
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {members.data.length <= 1 ? <ScreenEmpty kind="team" /> : null}
    </section>
  );
}

const sameLines = (a: string[] | null, b: string[] | null) =>
  a === null || b === null ? a === b : a.length === b.length && a.every((id) => b.includes(id));

function EditMember({
  orgId,
  actorRole,
  member,
  name,
  customRoles,
  customRoleId,
}: {
  orgId: string;
  actorRole: string;
  member: Member;
  name: string;
  customRoles: CustomRole[];
  customRoleId: string | null;
}) {
  const { t } = useTranslation('admin-team');
  const [open, setOpen] = useState(false);
  const [role, setRole] = useState<MemberRole>(member.role);
  const [locationIds, setLocationIds] = useState<string[] | null>(member.locationIds);
  const [roleId, setRoleId] = useState<string | null>(customRoleId);
  const save = useSetMemberRole(orgId);
  const assign = useAssignRole(orgId);
  // Lines: owners and admins set them (api.set_member_lines); they matter only while the org setting is on.
  const managesLines = canManageTeam(actorRole);
  const scoped = useQuery({ ...scopeStaffQuery(orgId), enabled: managesLines });
  const heldLines = useQuery({ ...memberLinesQuery(orgId), enabled: managesLines });
  const setLines = useSetMemberLines(orgId);
  const currentLines = heldLines.data?.[member.id] ?? null;
  const [queueIds, setQueueIds] = useState<string[] | null>(currentLines);
  const canPickLines = managesLines && role === 'staff' && scoped.data === true;
  // Custom roles are staff-based and owner-assigned; the database clears one on promotion.
  const canPickRole = actorRole === 'owner' && role === 'staff' && customRoles.length > 0;
  const failure = errorKey(save.error ?? assign.error ?? setLines.error);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const finish = () => setOpen(false);
    const lines = () =>
      canPickLines && !sameLines(queueIds, currentLines)
        ? setLines.mutate({ membershipId: member.id, queueIds }, { onSuccess: finish })
        : finish();
    save.mutate(
      { id: member.id, role, locationIds },
      {
        onSuccess: () =>
          canPickRole && roleId !== customRoleId
            ? assign.mutate({ membershipId: member.id, roleId }, { onSuccess: lines })
            : lines(),
      },
    );
  };
  const close = () => {
    setOpen(false);
    save.reset();
    assign.reset();
    setLines.reset();
  };

  return (
    <>
      <Button
        variant="secondary"
        aria-label={t('edit.triggerFor', { name })}
        onClick={() => {
          setRoleId(customRoleId);
          setRole(member.role);
          setLocationIds(member.locationIds);
          setQueueIds(currentLines);
          setOpen(true);
        }}
      >
        {t('edit.trigger')}
      </Button>
      <Dialog
        open={open}
        onClose={close}
        title={t('edit.title', { name })}
        description={t('edit.description')}
      >
        <form className="flex flex-col gap-4" onSubmit={submit}>
          <PresetPicker actor={actorRole} value={role} onChange={setRole} label={t('edit.role')} />
          <Advanced open={role === 'admin' || customRoleId !== null || member.locationIds !== null}>
            <AdminOption actor={actorRole} role={role} onChange={setRole} />
            {canPickRole ? (
              <Select
                label={t('edit.customRole')}
                hint={t('edit.customRoleHint')}
                value={roleId ?? ''}
                onChange={(event) => setRoleId(event.target.value || null)}
              >
                <option value="">{t('edit.noCustomRole')}</option>
                {customRoles.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </Select>
            ) : null}
            <LocationPicker
              orgId={orgId}
              value={locationIds}
              onChange={setLocationIds}
              label={t('edit.locations')}
              allLabel={t('edit.allLocations')}
            />
          </Advanced>
          {canPickLines ? (
            <LinePicker orgId={orgId} value={queueIds} onChange={setQueueIds} />
          ) : null}
          <p role="alert" className="font-medium text-danger-strong empty:hidden">
            {failure ? t(failure) : null}
          </p>
          <div className="flex justify-end gap-3">
            <Button variant="secondary" onClick={close}>
              {t('edit.cancel')}
            </Button>
            <Button
              type="submit"
              loading={save.isPending}
              loadingLabel={t('edit.saving')}
              disabled={
                (locationIds !== null && locationIds.length === 0) ||
                (canPickLines && queueIds !== null && queueIds.length === 0)
              }
            >
              {t('edit.save')}
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}

function RemoveMember({ orgId, member, name }: { orgId: string; member: Member; name: string }) {
  const { t } = useTranslation('admin-team');
  const [reason, setReason] = useState('');
  const remove = useRemoveMember(orgId);
  const failure = errorKey(remove.error);
  return (
    <ConfirmDestructive
      triggerLabel={t('remove.trigger')}
      triggerAriaLabel={t('remove.triggerFor', { name })}
      triggerVariant="secondary"
      title={t('remove.title', { name })}
      description={t('remove.description')}
      confirmLabel={t('remove.confirm')}
      cancelLabel={t('remove.cancel')}
      confirmDisabled={!reason.trim()}
      onConfirm={() => remove.mutateAsync({ id: member.id, reason }).catch(() => undefined)}
    >
      <Input
        label={t('remove.reason')}
        hint={t('remove.reasonHint')}
        maxLength={200}
        value={reason}
        onChange={(event) => setReason(event.target.value)}
      />
      <p role="alert" className="font-medium text-danger-strong empty:hidden">
        {failure ? t(failure) : null}
      </p>
    </ConfirmDestructive>
  );
}

function InviteDialog({ orgId, role }: { orgId: string; role: string }) {
  const { t } = useTranslation('admin-team');
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [invitedRole, setInvitedRole] = useState<MemberRole>('staff');
  const [locationIds, setLocationIds] = useState<string[] | null>(null);
  const [queueIds, setQueueIds] = useState<string[] | null>(null);
  // M3b: a front-desk invite can name its lines while the org limits staff to their lines.
  const scoped = useQuery(scopeStaffQuery(orgId));
  const canPickLines = invitedRole === 'staff' && scoped.data === true;
  const invite = useInviteStaff(orgId);
  const failure = errorKey(invite.error);

  const close = () => {
    setOpen(false);
    invite.reset();
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    invite.mutate(
      {
        email,
        role: invitedRole,
        locationIds,
        displayName: name,
        queueIds: canPickLines ? queueIds : null,
      },
      {
        onSuccess: () => {
          toast.show({ message: t('invite.sent', { email: email.trim() }), tone: 'success' });
          setEmail('');
          setName('');
          setInvitedRole('staff');
          setLocationIds(null);
          setQueueIds(null);
          close();
        },
      },
    );
  };

  return (
    <>
      <Button onClick={() => setOpen(true)}>{t('invite.trigger')}</Button>
      <Dialog
        open={open}
        onClose={close}
        title={t('invite.title')}
        description={t('invite.description')}
      >
        <form className="flex flex-col gap-4" onSubmit={submit}>
          <Input
            label={t('invite.email')}
            type="email"
            required
            autoComplete="off"
            maxLength={254}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
          <PresetPicker
            actor={role}
            value={invitedRole}
            onChange={setInvitedRole}
            label={t('invite.role')}
          />
          <Advanced>
            <Input
              label={t('invite.name')}
              hint={t('invite.nameHint')}
              maxLength={80}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            <AdminOption actor={role} role={invitedRole} onChange={setInvitedRole} />
            <LocationPicker
              orgId={orgId}
              value={locationIds}
              onChange={setLocationIds}
              label={t('invite.locations')}
              allLabel={t('invite.allLocations')}
            />
          </Advanced>
          {canPickLines ? (
            <LinePicker orgId={orgId} value={queueIds} onChange={setQueueIds} />
          ) : null}
          {isLimitReached(invite.error) ? (
            <ExtensionSlot
              name="limits.reached"
              props={{ kind: 'members', limit: limitOf(invite.error), role }}
            >
              <p role="alert" className="font-medium text-danger-strong">
                {limitOf(invite.error) === undefined
                  ? t('errors.limitReached')
                  : t('errors.limitReachedCount', { count: limitOf(invite.error) })}
              </p>
            </ExtensionSlot>
          ) : (
            <p role="alert" className="font-medium text-danger-strong empty:hidden">
              {failure ? t(failure) : null}
            </p>
          )}
          <div className="flex justify-end gap-3">
            <Button variant="secondary" onClick={close}>
              {t('invite.cancel')}
            </Button>
            <Button
              type="submit"
              loading={invite.isPending}
              loadingLabel={t('invite.sending')}
              disabled={
                (locationIds !== null && locationIds.length === 0) ||
                (canPickLines && queueIds !== null && queueIds.length === 0)
              }
            >
              {t('invite.send')}
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}

function Pending({ orgId, role }: { orgId: string; role: string }) {
  const { t, i18n } = useTranslation('admin-team');
  const toast = useToast();
  const invitations = useQuery(invitationsQuery(orgId));
  const revoke = useRevokeInvitation(orgId);
  const resend = useResendInvitation(orgId);
  const date = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium' });
  const failure = errorKey(resend.error ?? revoke.error);

  if (!invitations.data) return <Skeleton label={t('loading')} rows={2} />;
  return (
    <section className="flex flex-col gap-3" aria-labelledby="pending-heading">
      <h2 id="pending-heading" className="text-xl font-semibold">
        {t('pending.title')}
      </h2>
      <p role="alert" className="font-medium text-danger-strong empty:hidden">
        {failure ? t(failure) : null}
      </p>
      {invitations.data.length === 0 ? (
        <EmptyState title={t('pending.empty')} />
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {invitations.data.map((inv) => (
            <li
              key={inv.id}
              className="flex flex-wrap items-center justify-between gap-3 py-3"
              data-testid="invitation"
            >
              <div className="flex flex-col gap-1">
                <p className="font-semibold">{inv.email}</p>
                <p className="flex flex-wrap items-center gap-2 text-muted">
                  <Badge tone="info">{t(`role.${inv.role}`)}</Badge>
                  {t('pending.expires', { date: date.format(new Date(inv.expiresAt)) })}
                </p>
              </div>
              {canManageRole(role, inv.role) ? (
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="secondary"
                    loading={resend.isPending && resend.variables?.id === inv.id}
                    onClick={() =>
                      resend.mutate(inv, {
                        onSuccess: () =>
                          toast.show({
                            message: t('pending.resent', { email: inv.email }),
                            tone: 'success',
                          }),
                      })
                    }
                  >
                    {t('pending.resend')}
                  </Button>
                  <ConfirmDestructive
                    triggerLabel={t('pending.revoke')}
                    triggerVariant="secondary"
                    title={t('pending.revokeTitle', { email: inv.email })}
                    description={t('pending.revokeDescription')}
                    confirmLabel={t('pending.revokeConfirm')}
                    cancelLabel={t('pending.cancel')}
                    onConfirm={() => revoke.mutateAsync(inv.id).catch(() => undefined)}
                  />
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
