import { Checkbox, Input } from '@qm/ui';
import type { TFunction } from 'i18next';
import { useTranslation } from '../../../lib/translation.tsx';
import type { CatalogEntry } from '../catalog/api.ts';
import type { ProviderSetup } from '../templates.tsx';

/** Most personal lines one setup makes; the database refuses more. */
export const MAX_PROVIDERS = 20;

type T = TFunction<'onboarding'>;

/** "Doctor 2": the name a new personal line starts with until the owner types one. */
export function providerLabel(t: T, noun: string, n: number): string {
  return t('providers.defaultName', {
    noun: noun.charAt(0).toLocaleUpperCase() + noun.slice(1),
    n,
  });
}

/** The setup a provider template starts with: its default count, named "Doctor 1", "Doctor 2"... */
export function defaultProviders(
  providers: NonNullable<CatalogEntry['providers']>,
  t: T,
): ProviderSetup {
  const label = (n: number) => providerLabel(t, providers.noun, n);
  const count = Math.min(Math.max(providers.defaultCount, 1), MAX_PROVIDERS);
  return { names: Array.from({ length: count }, (_, i) => label(i + 1)), pool: providers.pool };
}

/** Resizes the list to `count`, keeping the names already typed and labelling the new ones. */
export function resize(
  setup: ProviderSetup,
  count: number,
  label: (n: number) => string,
): ProviderSetup {
  const n = Math.min(Math.max(Math.trunc(count) || 1, 1), MAX_PROVIDERS);
  return {
    ...setup,
    names: Array.from({ length: n }, (_, i) => setup.names[i] ?? label(i + 1)),
  };
}

/**
 * "How many doctors?" (T4, #1298): the count, a name for each personal line, and the optional
 * "Anyone available" line. Applying makes them all, with the template's services and form, at once.
 */
export function ProviderFields({
  noun,
  value,
  onChange,
}: {
  /** What one provider is called, from the template: "doctor". */
  noun: string;
  value: ProviderSetup;
  onChange: (next: ProviderSetup) => void;
}) {
  const { t } = useTranslation('onboarding');
  const label = (n: number) => providerLabel(t, noun, n);
  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="font-semibold">{t('providers.heading', { noun })}</legend>
      <Input
        label={t('providers.count', { noun })}
        hint={t('providers.countHint')}
        type="number"
        inputMode="numeric"
        min={1}
        max={MAX_PROVIDERS}
        value={String(value.names.length)}
        onChange={(e) => onChange(resize(value, Number(e.target.value), label))}
      />
      {value.names.map((name, i) => (
        <Input
          key={i}
          label={t('providers.name', { noun, n: i + 1 })}
          required
          maxLength={80}
          value={name}
          onChange={(e) =>
            onChange({ ...value, names: value.names.map((x, j) => (j === i ? e.target.value : x)) })
          }
        />
      ))}
      <Checkbox
        label={t('providers.pool')}
        hint={t('providers.poolHint', { noun })}
        checked={value.pool}
        onChange={(e) => onChange({ ...value, pool: e.target.checked })}
      />
    </fieldset>
  );
}
