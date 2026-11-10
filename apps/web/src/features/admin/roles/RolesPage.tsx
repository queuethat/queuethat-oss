import {
  Badge,
  Button,
  Checkbox,
  ConfirmDestructive,
  Dialog,
  EmptyState,
  Input,
  PageHeader,
  Skeleton,
} from '@qm/ui';
import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from '../../../lib/translation.tsx';
import { useCurrentOrg } from '../../auth/current.ts';
import {
  PERMISSION_GROUPS,
  canEditRoles,
  customRolesQuery,
  memberRolesQuery,
  useDeleteRole,
  useSaveRole,
  type CustomRole,
} from './api.ts';

const KNOWN_ERRORS = ['permission_denied', 'invalid_input', 'role_in_use'];

/** The translation key for a failed role action. */
function errorKey(error: Error | null) {
  if (!error) return null;
  return `errors.${KNOWN_ERRORS.includes(error.message) ? error.message : 'unknown'}` as 'errors.unknown';
}

/** Custom roles: named sets of permissions that owners hand to staff members (4-RBAC2, #374). */
export function RolesPage() {
  const { t } = useTranslation('admin-roles');
  const org = useCurrentOrg();
  const roles = useQuery({ ...customRolesQuery(org?.id ?? ''), enabled: !!org });
  const holders = useQuery({ ...memberRolesQuery(org?.id ?? ''), enabled: !!org });
  if (!org || !roles.data) return <Skeleton label={t('loading')} rows={2} />;
  const editable = canEditRoles(org.role);
  const inUse = (id: string) => Object.values(holders.data ?? {}).filter((r) => r === id).length;
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 pb-8">
      <PageHeader
        title={t('title')}
        description={editable ? t('intro') : t('readOnly')}
        actions={editable ? <RoleDialog orgId={org.id} /> : null}
      />
      {roles.data.length === 0 ? (
        <EmptyState title={t('empty.title')} description={t('empty.description')} />
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {roles.data.map((role) => (
            <li
              key={role.id}
              className="flex flex-wrap items-start justify-between gap-3 py-3"
              data-testid="custom-role"
            >
              <div className="flex flex-col gap-2">
                <h2 className="text-lg font-semibold">{role.name}</h2>
                <p className="flex flex-wrap gap-2">
                  {role.permissions.length === 0 ? (
                    <span className="text-muted">{t('noPermissions')}</span>
                  ) : (
                    role.permissions.map((p) => (
                      <Badge key={p} tone="info">
                        {t(`permission.${p}.label` as 'title')}
                      </Badge>
                    ))
                  )}
                </p>
                {holders.data ? (
                  <p className="text-muted">{t('holders', { count: inUse(role.id) })}</p>
                ) : null}
              </div>
              {editable ? (
                <div className="flex flex-wrap gap-2">
                  <RoleDialog orgId={org.id} role={role} />
                  <DeleteRole orgId={org.id} role={role} inUse={inUse(role.id) > 0} />
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RoleDialog({ orgId, role }: { orgId: string; role?: CustomRole }) {
  const { t } = useTranslation('admin-roles');
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(role?.name ?? '');
  const [permissions, setPermissions] = useState<string[]>(role?.permissions ?? []);
  const save = useSaveRole(orgId);
  const failure = errorKey(save.error);
  const reset = () => {
    setName(role?.name ?? '');
    setPermissions(role?.permissions ?? []);
    save.reset();
  };
  const close = () => {
    setOpen(false);
    reset();
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate(
      { id: role?.id, name, permissions },
      { onSuccess: () => (role ? setOpen(false) : close()) },
    );
  };
  return (
    <>
      <Button
        variant={role ? 'secondary' : 'primary'}
        aria-label={role ? t('edit.triggerFor', { name: role.name }) : undefined}
        onClick={() => {
          reset();
          setOpen(true);
        }}
      >
        {role ? t('edit.trigger') : t('create.trigger')}
      </Button>
      <Dialog
        open={open}
        onClose={close}
        title={role ? t('edit.title', { name: role.name }) : t('create.title')}
        description={t('dialogDescription')}
      >
        <form className="flex flex-col gap-4" onSubmit={submit}>
          <Input
            label={t('name')}
            hint={t('nameHint')}
            maxLength={60}
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          {PERMISSION_GROUPS.map(({ group, permissions: items }) => (
            <fieldset key={group} className="flex flex-col gap-2">
              <legend className="font-medium">{t(`group.${group}`)}</legend>
              {items.map((p) => (
                <Checkbox
                  key={p}
                  label={t(`permission.${p}.label`)}
                  hint={t(`permission.${p}.help`)}
                  checked={permissions.includes(p)}
                  onChange={(event) =>
                    setPermissions(
                      event.target.checked
                        ? [...permissions, p]
                        : permissions.filter((x) => x !== p),
                    )
                  }
                />
              ))}
            </fieldset>
          ))}
          <p role="alert" className="font-medium text-danger-strong empty:hidden">
            {failure ? t(failure) : null}
          </p>
          <div className="flex justify-end gap-3">
            <Button variant="secondary" onClick={close}>
              {t('cancel')}
            </Button>
            <Button
              type="submit"
              loading={save.isPending}
              loadingLabel={t('saving')}
              disabled={!name.trim()}
            >
              {t('save')}
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}

function DeleteRole({ orgId, role, inUse }: { orgId: string; role: CustomRole; inUse: boolean }) {
  const { t } = useTranslation('admin-roles');
  const remove = useDeleteRole(orgId);
  const failure = errorKey(remove.error);
  return (
    <ConfirmDestructive
      triggerLabel={t('delete.trigger')}
      triggerAriaLabel={t('delete.triggerFor', { name: role.name })}
      triggerVariant="secondary"
      title={t('delete.title', { name: role.name })}
      description={inUse ? t('delete.inUse') : t('delete.description')}
      confirmLabel={t('delete.confirm')}
      cancelLabel={t('delete.cancel')}
      confirmDisabled={inUse}
      onConfirm={() => remove.mutateAsync(role.id).catch(() => undefined)}
    >
      <p role="alert" className="font-medium text-danger-strong empty:hidden">
        {failure ? t(failure) : null}
      </p>
    </ConfirmDestructive>
  );
}
