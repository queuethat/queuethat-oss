import { errorCode, type ErrorCode } from '@qm/domain';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase.ts';
import { selectLocation } from '../auth/current.ts';
import { countryOfZone } from './countryOfZone.ts';
import { applyTemplate, type ProviderSetup, type TemplateResult } from './templates.tsx';

export interface BusinessSetup {
  businessName: string;
  /** The owner's own name for the team lists (#88); blank keeps their email there. */
  ownerName?: string;
  locationName: string;
  address: string;
  timeZone: string;
  queueName: string;
  serviceName: string;
  expectedMinutes: number;
  /** An industry template to apply instead of the hand-made queue and service; null starts blank. */
  templateKey: string | null;
  /** For a template with providers: their personal lines and the optional pool (T4). */
  providers?: ProviderSetup | null;
}

/** What has been created so far; passed back in to resume after a failure. */
export interface Created {
  orgId: string;
  locationId: string;
  queueId?: string;
  /** Set once a template has been applied; the key makes a retry a no-op. */
  template?: TemplateResult;
}

/** Thrown by `useSetUpBusiness`. `created` says which steps succeeded, so a retry resumes. */
export class SetupError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly created: Created | null,
  ) {
    super(code);
  }
}

/**
 * Creates the organization, its first location and owner membership (api.create_organization),
 * then the address, a first queue and its one service under RLS. Pass `resume` from a previous
 * SetupError to skip what already exists. On success the new location becomes current.
 */
export function useSetUpBusiness() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ setup, resume }: { setup: BusinessSetup; resume: Created | null }) => {
      let created = resume;
      try {
        if (!created) {
          const { data, error } = await supabase.rpc('create_organization', {
            p_name: setup.businessName,
            p_location_name: setup.locationName,
            p_tz: setup.timeZone,
          });
          if (error) throw error;
          created = { orgId: data.org_id!, locationId: data.location_id! };
          // The country follows the time zone (#88), so guests' phone fields start on the right
          // calling code; the owner can change it in the location settings.
          const country = countryOfZone(setup.timeZone);
          const details = {
            ...(setup.address.trim() ? { address: setup.address.trim() } : {}),
            ...(country ? { country_code: country } : {}),
          };
          if (Object.keys(details).length > 0) {
            const { error: detailsError } = await supabase
              .schema('app')
              .from('locations')
              .update(details)
              .eq('id', created.locationId);
            if (detailsError) throw detailsError;
          }
          const ownerName = setup.ownerName?.trim();
          if (ownerName) {
            const { data: me } = await supabase.auth.getUser();
            const { error: nameError } = await supabase
              .schema('app')
              .from('memberships')
              .update({ display_name: ownerName })
              .eq('org_id', created.orgId)
              .eq('user_id', me.user!.id);
            if (nameError) throw nameError;
          }
        }
        if (setup.templateKey) {
          const template =
            created.template ??
            (await applyTemplate(
              created.locationId,
              setup.templateKey,
              created.orgId,
              setup.providers ?? null,
            ));
          return { ...created, template };
        }
        if (!created.queueId) {
          const { data, error } = await supabase
            .schema('app')
            .from('queues')
            .insert({
              org_id: created.orgId,
              location_id: created.locationId,
              name: setup.queueName,
            })
            .select('id')
            .single();
          if (error) throw error;
          created = { ...created, queueId: data.id };
        }
        const app = supabase.schema('app');
        const { data: service, error } = await app
          .from('services')
          .insert({
            org_id: created.orgId,
            location_id: created.locationId,
            name: setup.serviceName,
            expected_minutes: setup.expectedMinutes,
          })
          .select('id')
          .single();
        if (error) throw error;
        const link = await app.from('queue_services').insert({
          org_id: created.orgId,
          location_id: created.locationId,
          queue_id: created.queueId!,
          service_id: service.id,
        });
        if (link.error) throw link.error;
        return created;
      } catch (error) {
        throw new SetupError(errorCode(error), created);
      }
    },
    onSuccess: async (created) => {
      selectLocation(created.locationId);
      await queryClient.invalidateQueries({ queryKey: ['auth', 'memberships'] });
      await queryClient.invalidateQueries({ queryKey: ['auth', 'locations'] });
    },
  });
}

/** IANA zones the browser knows, for the time zone picker. UTC is valid but not listed by Intl. */
export function timeZones(): string[] {
  const zones = Intl.supportedValuesOf('timeZone');
  return zones.includes('UTC') ? zones : ['UTC', ...zones];
}

/** The browser's own time zone, the wizard's default. `Etc/UTC` is normalised to `UTC`. */
export function browserTimeZone(): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return zone === 'Etc/UTC' ? 'UTC' : zone;
}
