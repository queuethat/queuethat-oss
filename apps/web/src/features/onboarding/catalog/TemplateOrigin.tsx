import { useQuery } from '@tanstack/react-query';
import { useTranslation } from '../../../lib/translation.tsx';
import { catalogQuery } from './api.ts';
import { useTemplateName } from './CatalogPicker.tsx';

/**
 * "Based on Barber v2" for something copied from the catalog. The copy is the owner's own: later
 * catalog versions never change it, so this names the version it was copied from.
 */
export function TemplateOrigin({ templateKey, version }: { templateKey: string; version: number }) {
  const { t, i18n } = useTranslation('onboarding');
  const name = useTemplateName();
  const { data: catalog = [] } = useQuery(catalogQuery(i18n.language));
  const entry = catalog.find((e) => e.key === templateKey);
  return (
    <p className="text-sm text-muted" data-testid="template-origin">
      {t('catalog.basedOn', {
        name: name({ key: templateKey, name: entry?.name ?? templateKey }),
        version,
      })}
    </p>
  );
}
