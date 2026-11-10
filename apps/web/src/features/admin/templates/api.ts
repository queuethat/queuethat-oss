import { errorCode, type ErrorCode } from '@qm/domain';
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../../lib/supabase.ts';

/** The triggers an owner can reword; the database refuses anything else (`invalid_trigger`). */
export const EDITABLE_TRIGGERS = [
  'called',
  'almost_up',
  'position_changed',
  'eta_changed',
] as const;
export const EDITABLE_CHANNELS = ['push', 'email', 'sms'] as const;
export type EditableTrigger = (typeof EDITABLE_TRIGGERS)[number];
export type EditableChannel = (typeof EDITABLE_CHANNELS)[number];

/** Templates are edited in the org's English wording; other locales fall back to it. */
const LOCALE = 'en';

export interface TemplateRow {
  id: string;
  /** Null = the system default. */
  orgId: string | null;
  /** Set for a queue override (2B-Q13); null for an org-wide row or the system default. */
  queueId: string | null;
  trigger: string;
  /** push, email or sms: named `medium` because `.channel` is reserved for Realtime. */
  medium: string;
  subject: string | null;
  body: string;
  version: number;
}

const templatesKey = (orgId: string, queueId?: string) =>
  ['admin', 'templates', orgId, queueId ?? null] as const;

/**
 * System defaults and this org's org-wide overrides; with `queueId`, also that queue's own
 * overrides (other queues' are never listed).
 */
export const templatesQuery = (orgId: string, queueId?: string) =>
  queryOptions({
    queryKey: templatesKey(orgId, queueId),
    queryFn: async (): Promise<TemplateRow[]> => {
      const base = supabase
        .schema('app')
        .from('notification_templates')
        .select('id, org_id, queue_id, trigger, medium:channel, subject, body, version')
        .eq('locale', LOCALE)
        .eq('active', true)
        .or(`org_id.is.null,org_id.eq.${orgId}`);
      const { data, error } = await (queueId
        ? base.or(`queue_id.is.null,queue_id.eq.${queueId}`)
        : base.is('queue_id', null));
      if (error) throw new Error(errorCode(error));
      return data.map((r) => ({
        id: r.id,
        orgId: r.org_id,
        queueId: r.queue_id,
        trigger: r.trigger,
        medium: r.medium,
        subject: r.subject,
        body: r.body,
        version: r.version,
      }));
    },
  });

export interface TemplateVersion {
  version: number;
  body: string;
  changedAt: string;
}

/** The saved versions of one override, newest first. */
export function useTemplateVersions(templateId: string | undefined) {
  return useQuery({
    queryKey: ['admin', 'template-versions', templateId],
    enabled: !!templateId,
    queryFn: async (): Promise<TemplateVersion[]> => {
      const { data, error } = await supabase
        .schema('app')
        .from('notification_template_versions')
        .select('version, body, changed_at')
        .eq('template_id', templateId!)
        .order('version', { ascending: false })
        .limit(10);
      if (error) throw new Error(errorCode(error));
      return data.map((r) => ({ version: r.version, body: r.body, changedAt: r.changed_at }));
    },
  });
}

/** A rejected save: the stable code and, for `unknown_variable`, the offending name. */
export class TemplateSaveError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly detail?: string,
  ) {
    super(code);
  }
}

export interface TemplateDraft {
  trigger: EditableTrigger;
  medium: EditableChannel;
  subject: string;
  body: string;
}

/**
 * Saves an override: updates the org's own row, or creates it from the default. Rejects with a
 * TemplateSaveError (`unknown_variable`, `permission_denied`, `invalid_input`...).
 */
export function useSaveTemplate(orgId: string, queueId?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ draft, existingId }: { draft: TemplateDraft; existingId?: string }) => {
      const fields = {
        body: draft.body.trim(),
        subject: draft.medium === 'email' ? draft.subject.trim() || null : null,
      };
      const table = supabase.schema('app').from('notification_templates');
      const { error } = existingId
        ? await table.update(fields).eq('id', existingId)
        : await table.insert({
            ...fields,
            org_id: orgId,
            ...(queueId ? { queue_id: queueId } : {}),
            trigger: draft.trigger,
            channel: draft.medium,
            locale: LOCALE,
          });
      if (error) throw new TemplateSaveError(errorCode(error), error.details ?? undefined);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin'] }),
  });
}

/** Deletes the org's override, so the system default applies to the next message. */
export function useRevertTemplate(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (templateId: string) => {
      const { error } = await supabase
        .schema('app')
        .from('notification_templates')
        .delete()
        .eq('id', templateId)
        .eq('org_id', orgId);
      if (error) throw new Error(errorCode(error));
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin'] }),
  });
}
