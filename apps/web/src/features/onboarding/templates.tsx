import { errorCode } from '@qm/domain';
import { Button } from '@qm/ui';
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from '../../lib/translation.tsx';
import { supabase } from '../../lib/supabase.ts';

export interface IndustryTemplate {
  key: string;
  name: string;
  description: string;
  /** Clinics and the like: tickets only on screens, never names. */
  healthTagged: boolean;
}

/** What `apply_industry_template` created. */
export interface TemplateResult {
  templateKey: string;
  queuesCreated: number;
  servicesCreated: number;
  countersCreated: number;
}

/** The setup templates the database offers, in its order. */
export const templatesQuery = queryOptions({
  queryKey: ['onboarding', 'templates'],
  staleTime: Infinity,
  queryFn: async (): Promise<IndustryTemplate[]> => {
    const { data, error } = await supabase.rpc('list_industry_templates');
    if (error) throw error;
    return data.map((row) => ({
      key: row.key!,
      name: row.name!,
      description: row.description!,
      healthTagged: !!row.health_tagged,
    }));
  },
});

/** Applies a template to a location in one transaction; a retry with the same key is a no-op. */
export async function applyTemplate(
  locationId: string,
  templateKey: string,
  idempotencyKey: string,
): Promise<TemplateResult> {
  const { data, error } = await supabase.rpc('apply_industry_template', {
    p_location_id: locationId,
    p_template_key: templateKey,
    p_idempotency_key: idempotencyKey,
  });
  if (error) throw new Error(errorCode(error));
  return {
    templateKey: data.template_key!,
    queuesCreated: data.queues_created ?? 0,
    servicesCreated: data.services_created ?? 0,
    countersCreated: data.counters_created ?? 0,
  };
}

/** Applies a template from the location settings page and refreshes what it created. */
export function useApplyTemplate(locationId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      templateKey,
      idempotencyKey,
    }: {
      templateKey: string;
      idempotencyKey: string;
    }) => applyTemplate(locationId, templateKey, idempotencyKey),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin'] }),
  });
}

/** One card per template plus "Start blank" (`value` null). Choosing is a toggle, not a commit. */
export function TemplatePicker({
  value,
  onChange,
  withBlank = true,
}: {
  value: string | null;
  onChange: (key: string | null) => void;
  /** Offers "Start blank"; off when applying to an existing location. */
  withBlank?: boolean;
}) {
  const { t } = useTranslation('onboarding');
  const { data: templates = [] } = useQuery(templatesQuery);
  return (
    <div className="flex flex-col gap-3" role="group" aria-label={t('templates.heading')}>
      {withBlank ? (
        <Button
          variant={value === null ? 'primary' : 'secondary'}
          aria-pressed={value === null}
          className="h-auto justify-start py-3 text-left"
          onClick={() => onChange(null)}
        >
          <span className="flex flex-col">
            <span>{t('templates.blank')}</span>
            <span className="text-sm font-normal">{t('templates.blankHint')}</span>
          </span>
        </Button>
      ) : null}
      {templates.map((tpl) => (
        <Button
          key={tpl.key}
          variant={value === tpl.key ? 'primary' : 'secondary'}
          aria-pressed={value === tpl.key}
          className="h-auto justify-start py-3 text-left"
          onClick={() => onChange(tpl.key)}
        >
          <span className="flex flex-col">
            <span>{t(`templates.names.${tpl.key}`, { defaultValue: tpl.name })}</span>
            <span className="text-sm font-normal">
              {t(`templates.descriptions.${tpl.key}`, { defaultValue: tpl.description })}
            </span>
            {tpl.healthTagged ? (
              <span className="text-sm font-semibold">{t('templates.privacyNote')}</span>
            ) : null}
          </span>
        </Button>
      ))}
    </div>
  );
}
