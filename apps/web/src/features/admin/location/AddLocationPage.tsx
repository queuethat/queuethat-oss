import { Button, Input, LinkButton, PageHeader } from '@qm/ui';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { useTranslation } from '../../../lib/translation.tsx';
import { useCurrentOrg } from '../../auth/current.ts';
import { browserTimeZone, timeZones } from '../../onboarding/api.ts';
import { useAddLocation } from './addApi.ts';

const KNOWN_ERRORS = ['invalid_timezone', 'invalid_input', 'slug_taken', 'permission_denied'];

/**
 * Adds a location to the current organization (#1080). Admins and owners only; the database
 * enforces that.
 */
export function AddLocationPage() {
  const { t } = useTranslation('admin');
  const navigate = useNavigate();
  const org = useCurrentOrg();
  const add = useAddLocation();
  const [zones] = useState(timeZones);
  const [name, setName] = useState('');
  const [timeZone, setTimeZone] = useState(browserTimeZone);
  const [slug, setSlug] = useState('');
  const canAdd = org?.role === 'owner' || org?.role === 'admin';
  const zoneInvalid = !zones.includes(timeZone);

  const code = add.error ? add.error.message : null;
  const failure = code
    ? `addLocation.errors.${KNOWN_ERRORS.includes(code) ? code : 'unknown'}`
    : null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!org || !canAdd || zoneInvalid || !name.trim()) return;
    add.mutate(
      { orgId: org.id, name, timeZone, slug },
      { onSuccess: () => void navigate({ to: '/admin/location' }) },
    );
  };

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4 pb-8">
      <PageHeader
        title={t('addLocation.title')}
        description={canAdd ? t('addLocation.intro') : t('addLocation.adminsOnly')}
      />
      <p role="alert" className="font-medium text-danger-strong empty:hidden">
        {failure ? t(failure as 'addLocation.errors.unknown') : null}
      </p>
      <form className="flex flex-col gap-4" onSubmit={submit}>
        <Input
          label={t('location.name')}
          hint={t('addLocation.nameHint')}
          required
          maxLength={120}
          pattern=".*\S.*"
          readOnly={!canAdd}
          value={name}
          onChange={(event) => {
            add.reset();
            setName(event.target.value);
          }}
        />
        <Input
          label={t('location.timeZone')}
          hint={t('addLocation.tzHint')}
          list="add-location-zones"
          required
          readOnly={!canAdd}
          error={zoneInvalid && timeZone ? t('errors.invalid_timezone') : undefined}
          value={timeZone}
          onChange={(event) => {
            add.reset();
            setTimeZone(event.target.value);
          }}
        />
        <datalist id="add-location-zones">
          {zones.map((zone) => (
            <option key={zone} value={zone} />
          ))}
        </datalist>
        <Input
          label={t('location.slug')}
          hint={t('addLocation.slugHint')}
          maxLength={64}
          readOnly={!canAdd}
          value={slug}
          onChange={(event) => {
            add.reset();
            setSlug(event.target.value);
          }}
        />
        <div className="flex flex-wrap gap-3">
          <Button type="submit" disabled={!canAdd || add.isPending}>
            {t('addLocation.submit')}
          </Button>
          <LinkButton variant="secondary" render={(p) => <Link to="/admin/location" {...p} />}>
            {t('addLocation.cancel')}
          </LinkButton>
        </div>
      </form>
    </div>
  );
}
