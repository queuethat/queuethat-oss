import { Button, Checkbox, Input, LinkButton, PageHeader, Select, Skeleton } from '@qm/ui';
import { phoneCountries } from '@qm/ui/phone';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { useTranslation } from '../../../lib/translation.tsx';
import { useCurrentLocation, useCurrentOrg } from '../../auth/current.ts';
import { AnnounceSettings } from './AnnounceSettings.tsx';
import { PositionFields } from './PositionFields.tsx';
import { ApplyTemplate } from '../../onboarding/ApplyTemplate.tsx';
import { timeZones } from '../../onboarding/api.ts';
import { publicJoinUrl } from '../poster/url.ts';
import {
  canEditLocation,
  locationSettingsQuery,
  parsePosition,
  useSaveLocationSettings,
  type LocationSettings,
} from './api.ts';

const KNOWN_ERRORS = ['invalid_timezone', 'permission_denied', 'display_names_locked'];

/** Settings for the current location (A4, #44). Staff and managers see them read-only. */
export function LocationSettingsPage() {
  const { t } = useTranslation('admin');
  const { location } = useCurrentLocation();
  const role = useCurrentOrg()?.role;
  const query = useQuery({ ...locationSettingsQuery(location?.id ?? ''), enabled: !!location });
  if (!location || !query.data) return <Skeleton label={t('location.loading')} rows={2} />;
  return (
    <LocationSettingsForm
      // A different location starts a fresh form.
      key={location.id}
      locationId={location.id}
      slug={query.data.slug}
      saved={query.data.settings}
      readOnly={!canEditLocation(role)}
    />
  );
}

function LocationSettingsForm({
  locationId,
  slug,
  saved,
  readOnly,
}: {
  locationId: string;
  slug: string;
  saved: LocationSettings;
  readOnly: boolean;
}) {
  const { t } = useTranslation('admin');
  const save = useSaveLocationSettings(locationId);
  const [settings, setSettings] = useState(saved);
  const [zones] = useState(timeZones);
  const [countries] = useState(() => phoneCountries());
  const [copied, setCopied] = useState(false);

  const text = (
    key: Exclude<
      keyof LocationSettings,
      | 'displayNamesEnabled'
      | 'country'
      | 'onsiteCodeRequired'
      | 'onsiteCodeRotateMinutes'
      | 'printPaperMm'
      | 'announceLocales'
      | 'announceVoicePrefs'
      | 'announceRepeat'
      | 'geofenceM'
    >,
  ) => ({
    value: settings[key],
    readOnly,
    onChange: (event: { target: { value: string } }) => {
      save.reset();
      setSettings((s) => ({ ...s, [key]: event.target.value }));
    },
  });
  const fields = {
    name: text('name'),
    address: text('address'),
    contact: text('contact'),
    tz: text('tz'),
    dayBoundary: text('dayBoundary'),
    printFooter: text('printFooter'),
  };

  // A zone saved before this browser's list changed stays valid.
  const zoneInvalid = !zones.includes(settings.tz) && settings.tz !== saved.tz;
  const joinUrl = publicJoinUrl(slug);
  const failure = save.error
    ? `errors.${KNOWN_ERRORS.includes(save.error.message) ? save.error.message : 'unknown'}`
    : null;
  const status = save.isSuccess ? t('location.saved') : copied ? t('location.copied') : null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (readOnly || zoneInvalid) return;
    if (parsePosition(settings.lat, settings.lng) === undefined) return;
    if (!(settings.onsiteCodeRotateMinutes >= 2 && settings.onsiteCodeRotateMinutes <= 60)) return;
    save.mutate(settings);
  };

  const copyLink = async () => {
    // The clipboard needs a secure context; the field stays selectable either way.
    await navigator.clipboard?.writeText(joinUrl).then(
      () => setCopied(true),
      () => {},
    );
  };

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4 pb-8">
      <PageHeader
        title={t('location.title')}
        description={readOnly ? t('location.readOnly') : undefined}
      />
      <p role="alert" className="font-medium text-danger-strong empty:hidden">
        {failure ? t(failure as 'errors.unknown') : null}
      </p>
      <p role="status" className="font-medium empty:hidden">
        {status}
      </p>
      <form className="flex flex-col gap-4" onSubmit={submit}>
        <Input
          label={t('location.name')}
          required
          maxLength={120}
          pattern=".*\S.*"
          {...fields.name}
        />
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-60 flex-1">
            <Input label={t('location.slug')} hint={t('location.slugHint')} value={slug} readOnly />
          </div>
          <Button variant="secondary" onClick={() => void copyLink()}>
            {t('location.copyLink')}
          </Button>
          <LinkButton variant="secondary" render={(p) => <Link to="/admin/poster" {...p} />}>
            {t('location.poster')}
          </LinkButton>
          <LinkButton
            variant="secondary"
            render={(p) => <Link to="/admin/location/hours" {...p} />}
          >
            {t('location.hours')}
          </LinkButton>
          <LinkButton variant="secondary" render={(p) => <Link to="/admin/team" {...p} />}>
            {t('location.team')}
          </LinkButton>
          {readOnly ? null : (
            <LinkButton
              variant="secondary"
              render={(p) => <Link to="/admin/location/new" {...p} />}
            >
              {t('location.addLocation')}
            </LinkButton>
          )}
        </div>
        <Input
          label={t('location.address')}
          autoComplete="street-address"
          maxLength={300}
          {...fields.address}
        />
        <Input
          label={t('location.contact')}
          hint={t('location.contactHint')}
          maxLength={200}
          {...fields.contact}
        />
        <Input
          label={t('location.timeZone')}
          hint={t('location.timeZoneHint')}
          list="location-time-zones"
          required
          error={zoneInvalid ? t('errors.invalid_timezone') : undefined}
          {...fields.tz}
        />
        <datalist id="location-time-zones">
          {zones.map((zone) => (
            <option key={zone} value={zone} />
          ))}
        </datalist>
        <Select
          label={t('location.country')}
          hint={t('location.countryHint')}
          value={settings.country}
          disabled={readOnly}
          onChange={(event) => {
            save.reset();
            setSettings((s) => ({ ...s, country: event.target.value }));
          }}
        >
          <option value="">{t('location.countryNotSet')}</option>
          {countries.map((c) => (
            <option key={c.code} value={c.code}>
              {c.name}
            </option>
          ))}
        </Select>
        <Input
          label={t('location.dayBoundary')}
          hint={t('location.dayBoundaryHint')}
          type="time"
          required
          {...fields.dayBoundary}
        />
        <Checkbox
          label={t('location.displayNames')}
          hint={t('location.displayNamesHint')}
          checked={settings.displayNamesEnabled}
          disabled={readOnly}
          onChange={(event) => {
            save.reset();
            setSettings((s) => ({ ...s, displayNamesEnabled: event.target.checked }));
          }}
        />
        <Select
          label={t('location.printPaper')}
          value={String(settings.printPaperMm)}
          disabled={readOnly}
          onChange={(event) => {
            save.reset();
            setSettings((s) => ({ ...s, printPaperMm: event.target.value === '58' ? 58 : 80 }));
          }}
        >
          <option value="80">{t('location.printPaper80')}</option>
          <option value="58">{t('location.printPaper58')}</option>
        </Select>
        <Input
          label={t('location.printFooter')}
          hint={t('location.printFooterHint')}
          maxLength={120}
          {...fields.printFooter}
        />
        <AnnounceSettings
          value={settings}
          readOnly={readOnly}
          onChange={(next) => {
            save.reset();
            setSettings((s) => ({ ...s, ...next }));
          }}
        />
        {settings.displayNamesEnabled ? (
          <p
            className="rounded-control border border-warning-strong bg-warning-soft p-3 text-warning-strong"
            data-testid="display-names-warning"
          >
            {t('location.displayNamesWarning')}
          </p>
        ) : null}
        <Checkbox
          label={t('location.onsiteCode')}
          hint={t('location.onsiteCodeHint')}
          checked={settings.onsiteCodeRequired}
          disabled={readOnly}
          onChange={(event) => {
            save.reset();
            setSettings((s) => ({ ...s, onsiteCodeRequired: event.target.checked }));
          }}
        />
        {settings.onsiteCodeRequired ? (
          <Input
            label={t('location.onsiteCodeMinutes')}
            hint={t('location.onsiteCodeMinutesHint')}
            type="number"
            inputMode="numeric"
            min={2}
            max={60}
            required
            readOnly={readOnly}
            value={settings.onsiteCodeRotateMinutes}
            onChange={(event) => {
              save.reset();
              const minutes = Math.round(Number(event.target.value));
              setSettings((s) => ({ ...s, onsiteCodeRotateMinutes: minutes }));
            }}
          />
        ) : null}
        <PositionFields
          settings={settings}
          readOnly={readOnly}
          onChange={(next) => {
            save.reset();
            setSettings((s) => ({ ...s, ...next }));
          }}
        />
        {readOnly ? null : <ApplyTemplate locationId={locationId} />}
        {readOnly ? null : (
          <Button
            type="submit"
            className="self-end"
            loading={save.isPending}
            loadingLabel={t('location.saving')}
          >
            {t('location.save')}
          </Button>
        )}
      </form>
    </div>
  );
}
