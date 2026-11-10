import { Button, Checkbox, Input, PageHeader, Skeleton, Textarea } from '@qm/ui';
import { useQuery } from '@tanstack/react-query';
import { useState, type ChangeEvent, type FormEvent } from 'react';
import { useTranslation } from '../../../lib/translation.tsx';
import { accessibleTextColor, isHexColor, whiteTextPasses } from '@qm/domain';
import { useCurrentLocation, useCurrentOrg } from '../../auth/current.ts';
import { SWATCH_BRANDING } from '../swatch.ts';
import {
  brandingQuery,
  brandingUrl,
  useSaveBranding,
  useSetBrandImage,
  useSetHideProductBranding,
  type BrandingSettings,
} from './api.ts';
import { isAcceptedImage, reencode } from './image.ts';

const WELCOME_MAX = 500;
const isHttps = (value: string) => value === '' || /^https:\/\/\S+$/.test(value);

/**
 * `/admin/branding` (2P-BRD2, #203): logo, cover, colours, welcome text and legal links that
 * guest pages show. Admins and owners edit; the database policies decide, the form mirrors them.
 */
export function BrandingPage() {
  const { t } = useTranslation('admin');
  const org = useCurrentOrg();
  const { location } = useCurrentLocation();
  const query = useQuery({
    ...brandingQuery(org?.id ?? '', location?.id ?? ''),
    enabled: !!org && !!location,
  });
  if (!org || !location || !query.data) return <Skeleton label={t('branding.loading')} rows={2} />;
  return (
    <BrandingForm
      key={location.id}
      orgId={org.id}
      orgName={org.name}
      locationId={location.id}
      saved={query.data}
      readOnly={org.role !== 'owner' && org.role !== 'admin'}
      isOwner={org.role === 'owner'}
    />
  );
}

function BrandingForm({
  orgId,
  orgName,
  locationId,
  saved,
  readOnly,
  isOwner,
}: {
  orgId: string;
  orgName: string;
  locationId: string;
  saved: BrandingSettings;
  readOnly: boolean;
  isOwner: boolean;
}) {
  const { t } = useTranslation('admin');
  const hideName = useSetHideProductBranding(orgId);
  const save = useSaveBranding(orgId, locationId);
  const setImage = useSetBrandImage(orgId, locationId);
  const [form, setForm] = useState(saved);
  const [imageError, setImageError] = useState<string>();
  const set = (patch: Partial<BrandingSettings>) => {
    save.reset();
    setForm((f) => ({ ...f, ...patch }));
  };

  async function pick(kind: 'logo' | 'cover', event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setImageError(undefined);
    if (!isAcceptedImage(file)) return setImageError(t('branding.image.type'));
    try {
      const image = await reencode(file);
      const previous = kind === 'logo' ? saved.logoPath : saved.coverPath;
      await setImage.mutateAsync({ kind, image, previous });
    } catch {
      setImageError(t('branding.image.failed'));
    }
  }
  // After an upload the query refetches; take the stored paths from it.
  const logoPath = saved.logoPath;
  const coverPath = saved.coverPath;

  const colourOk = (c: string) => c === '' || isHexColor(c);
  const urlsOk = isHttps(form.termsUrl.trim()) && isHttps(form.privacyUrl.trim());
  const canSave = !readOnly && colourOk(form.brandPrimary) && colourOk(form.brandAccent) && urlsOk;
  const headerText = form.brandPrimary ? accessibleTextColor(form.brandPrimary) : undefined;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 pb-8">
      <PageHeader
        title={t('branding.title')}
        description={readOnly ? t('branding.readOnly') : t('branding.intro')}
      />
      <div
        data-testid="branding-preview"
        className="flex flex-col gap-2 rounded p-4"
        style={{
          backgroundColor: form.brandPrimary || undefined,
          color: headerText,
          border: form.brandPrimary ? undefined : '1px solid currentColor',
        }}
      >
        <div className="flex items-center gap-3">
          {logoPath ? (
            <img src={brandingUrl(logoPath)} alt="" className="size-10 rounded object-contain" />
          ) : null}
          <strong className="text-xl">{orgName}</strong>
        </div>
        {form.welcomeText ? <p>{form.welcomeText}</p> : null}
      </div>
      {imageError ? (
        <p role="alert" className="text-danger-strong font-medium">
          {imageError}
        </p>
      ) : null}
      <ImageField
        kind="logo"
        path={logoPath}
        readOnly={readOnly}
        onPick={(e) => void pick('logo', e)}
        onRemove={(path) => setImage.mutate({ kind: 'logo', image: null, previous: path })}
      />
      <ImageField
        kind="cover"
        path={coverPath}
        readOnly={readOnly}
        onPick={(e) => void pick('cover', e)}
        onRemove={(path) => setImage.mutate({ kind: 'cover', image: null, previous: path })}
      />
      <form
        className="flex flex-col gap-4"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          save.mutate(form);
        }}
      >
        <ColourField
          label={t('branding.colour.primary')}
          value={form.brandPrimary}
          readOnly={readOnly}
          onChange={(v) => set({ brandPrimary: v })}
        />
        <ColourField
          label={t('branding.colour.accent')}
          value={form.brandAccent}
          readOnly={readOnly}
          onChange={(v) => set({ brandAccent: v })}
        />
        <Textarea
          label={t('branding.welcome.label')}
          hint={t('branding.welcome.count', { count: form.welcomeText.length, max: WELCOME_MAX })}
          maxLength={WELCOME_MAX}
          readOnly={readOnly}
          value={form.welcomeText}
          onChange={(event) => set({ welcomeText: event.target.value })}
        />
        <Input
          label={t('branding.terms')}
          type="url"
          inputMode="url"
          readOnly={readOnly}
          value={form.termsUrl}
          error={isHttps(form.termsUrl.trim()) ? undefined : t('branding.https')}
          onChange={(event) => set({ termsUrl: event.target.value })}
        />
        <Input
          label={t('branding.privacy')}
          type="url"
          inputMode="url"
          readOnly={readOnly}
          value={form.privacyUrl}
          error={isHttps(form.privacyUrl.trim()) ? undefined : t('branding.https')}
          onChange={(event) => set({ privacyUrl: event.target.value })}
        />
        <Checkbox
          label={t('branding.hideProduct.label')}
          hint={isOwner ? t('branding.hideProduct.hint') : t('branding.hideProduct.ownerOnly')}
          checked={saved.hideProductBranding}
          disabled={!isOwner || hideName.isPending}
          onChange={(event) => hideName.mutate(event.target.checked)}
        />
        {hideName.error ? (
          <p role="alert" className="text-danger-strong font-medium">
            {t('branding.hideProduct.failed')}
          </p>
        ) : null}
        {save.error ? (
          <p role="alert" className="text-danger-strong font-medium">
            {t('branding.saveFailed')}
          </p>
        ) : null}
        {save.isSuccess ? <p role="status">{t('branding.saved')}</p> : null}
        {readOnly ? null : (
          <Button
            type="submit"
            disabled={!canSave}
            loading={save.isPending}
            loadingLabel={t('branding.saving')}
          >
            {t('branding.save')}
          </Button>
        )}
      </form>
    </div>
  );
}

function ColourField({
  label,
  value,
  readOnly,
  onChange,
}: {
  label: string;
  value: string;
  readOnly: boolean;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation('admin');
  return (
    <div className="flex flex-col gap-2">
      <Input
        label={label}
        type="color"
        value={value || SWATCH_BRANDING}
        disabled={readOnly}
        onChange={(event) => onChange(event.target.value)}
      />
      {value && !whiteTextPasses(value) ? (
        <p role="status" className="text-warning-strong font-medium" data-testid="colour-warning">
          {t('branding.colour.low', { text: t(`branding.colour.${accessibleTextColor(value)}`) })}
        </p>
      ) : null}
      {value && !readOnly ? (
        <Button variant="secondary" onClick={() => onChange('')}>
          {t('branding.colour.clear')}
        </Button>
      ) : null}
    </div>
  );
}

function ImageField({
  kind,
  path,
  readOnly,
  onPick,
  onRemove,
}: {
  kind: 'logo' | 'cover';
  path: string | null;
  readOnly: boolean;
  onPick: (event: ChangeEvent<HTMLInputElement>) => void;
  onRemove: (path: string) => void;
}) {
  const { t } = useTranslation('admin');
  return (
    <div className="flex flex-col gap-2">
      {path ? (
        <img
          src={brandingUrl(path)}
          alt={t(`branding.${kind}.alt`)}
          className="max-h-32 w-auto self-start rounded"
          data-testid={`${kind}-preview`}
        />
      ) : (
        <p className="text-muted">{t('branding.image.none')}</p>
      )}
      {readOnly ? null : (
        <>
          <Input
            label={t(`branding.${kind}.choose`)}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            onChange={onPick}
          />
          {path ? (
            <Button variant="secondary" onClick={() => onRemove(path)}>
              {t(`branding.${kind}.remove`)}
            </Button>
          ) : null}
        </>
      )}
    </div>
  );
}
