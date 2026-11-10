import { errorCode } from '@qm/domain';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../../lib/supabase.ts';
import type { BuilderField } from './builder/fields.ts';
import { fieldsPayload, fromStored } from './fields.ts';

export type Channel = 'any' | 'walk_in' | 'booking';
export const CHANNELS: Channel[] = ['any', 'walk_in', 'booking'];

/** Library forms allowed per location; the database enforces it (`invalid_input`). */
export const FORM_LIMIT = 3;

export interface FormTarget {
  /** Queue or service id, which is what attach and detach take. */
  targetId: string;
  kind: 'queue' | 'service';
  scope: Channel;
}

export interface FormRow {
  id: string;
  name: string;
  purposeText: string;
  retentionDays: number | null;
  status: 'draft' | 'published';
  isQueueDefault: boolean;
  /** Newest published version, or null while never published. */
  liveVersion: number | null;
  /** The draft if one is pending, otherwise the live fields: what the editor opens. */
  fields: BuilderField[];
  hasDraft: boolean;
  targets: FormTarget[];
}

export interface Placement {
  id: string;
  name: string;
  kind: 'queue' | 'service';
}

const formsKey = (locationId: string) => ['admin', 'forms', locationId];

/** The location's forms with their newest version and where each is shown, read under RLS. */
export const formsQuery = (locationId: string) =>
  queryOptions({
    queryKey: formsKey(locationId),
    queryFn: async () => {
      const { data, error } = await supabase
        .schema('app')
        .from('forms')
        .select(
          'id, name, purpose_text, retention_days, status, is_queue_default, created_at, form_versions(version, fields, published_at), form_targets(queue_id, service_id, scope:channel)',
        )
        .eq('location_id', locationId)
        .order('is_queue_default')
        .order('created_at');
      if (error) throw error;
      return data.map((f): FormRow => {
        const versions = [...f.form_versions].sort((a, b) => b.version - a.version);
        const draft = versions.find((v) => v.published_at === null);
        const live = versions.find((v) => v.published_at !== null);
        return {
          id: f.id,
          name: f.name,
          purposeText: f.purpose_text ?? '',
          retentionDays: f.retention_days,
          status: f.status as FormRow['status'],
          isQueueDefault: f.is_queue_default,
          liveVersion: live?.version ?? null,
          fields: fromStored((draft ?? live)?.fields),
          hasDraft: !!draft,
          targets: f.form_targets.map(({ queue_id, service_id, scope }) => ({
            targetId: (queue_id ?? service_id)!,
            kind: queue_id ? 'queue' : 'service',
            scope: scope as Channel,
          })),
        };
      });
    },
  });

/** Whether the org is health-tagged, which makes free-text questions warn. */
export const healthTaggedQuery = (orgId: string) =>
  queryOptions({
    queryKey: ['admin', 'forms', 'health', orgId],
    queryFn: async () => {
      const { data, error } = await supabase
        .schema('app')
        .from('organizations')
        .select('health_tagged')
        .eq('id', orgId)
        .single();
      if (error) throw error;
      return data.health_tagged;
    },
  });

/** Queues and services of the location: everything a form can be shown on. */
export const placementsQuery = (locationId: string) =>
  queryOptions({
    queryKey: ['admin', 'form-placements', locationId],
    queryFn: async (): Promise<Placement[]> => {
      const { data, error } = await supabase
        .schema('app')
        .from('queues')
        .select('id, name, services(id, name, active)')
        .eq('location_id', locationId)
        .is('archived_at', null)
        .order('name');
      if (error) throw error;
      return data.flatMap((q) => [
        { id: q.id, name: q.name, kind: 'queue' as const },
        ...q.services
          .filter((s) => s.active)
          .map((s) => ({ id: s.id, name: `${q.name} / ${s.name}`, kind: 'service' as const })),
      ]);
    },
  });

type Change =
  | {
      kind: 'save';
      formId: string | null;
      name: string;
      purposeText: string;
      retentionDays: number;
      fields: BuilderField[];
      publish: boolean;
    }
  | { kind: 'attach'; formId: string; targetIds: string[]; scope: Channel }
  | { kind: 'detach'; formId: string; targetIds: string[]; scope: Channel };

/**
 * Saves a draft (and publishes it when asked), attaches, or detaches. Publishing makes every
 * target follow the new version; detach is undone by attaching the same ids again.
 */
export function useChangeForms(org: { id: string; locationId: string }) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (c: Change) => {
      if (c.kind === 'save') {
        const saved = await supabase.rpc('save_form_draft', {
          p_org_id: org.id,
          p_location_id: org.locationId,
          p_form_id: c.formId as string,
          p_name: c.name,
          p_purpose_text: c.purposeText,
          p_retention_days: c.retentionDays,
          p_fields: fieldsPayload(c.fields),
        });
        if (saved.error) throw new Error(errorCode(saved.error));
        if (c.publish) {
          const { error } = await supabase.rpc('publish_form_version', {
            p_org_id: org.id,
            p_form_id: saved.data,
          });
          if (error) throw new Error(errorCode(error));
        }
        return;
      }
      const args = {
        p_org_id: org.id,
        p_form_id: c.formId,
        p_target_ids: c.targetIds,
        p_channel: c.scope,
      };
      const { error } =
        c.kind === 'attach'
          ? await supabase.rpc('attach_form', args)
          : await supabase.rpc('detach_form', args);
      if (error) throw new Error(errorCode(error));
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: formsKey(org.locationId) }),
  });
}
