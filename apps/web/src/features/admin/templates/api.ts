import { errorCode, type ErrorCode } from '@qm/domain';
import {
  keepPreviousData,
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
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

/** The languages a guest can pick; each has its own templates, falling back as the database resolves them. */
export const TEMPLATE_LOCALES = ['en', 'es'] as const;
export type TemplateLocale = (typeof TEMPLATE_LOCALES)[number];

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

const templatesKey = (orgId: string, queueId?: string, locale: TemplateLocale = 'en') =>
  ['admin', 'templates', orgId, queueId ?? null, locale] as const;

/**
 * System defaults and this org's org-wide overrides; with `queueId`, also that queue's own
 * overrides (other queues' are never listed).
 */
export const templatesQuery = (orgId: string, queueId?: string, locale: TemplateLocale = 'en') =>
  queryOptions({
    queryKey: templatesKey(orgId, queueId, locale),
    queryFn: async (): Promise<TemplateRow[]> => {
      const base = supabase
        .schema('app')
        .from('notification_templates')
        .select('id, org_id, queue_id, trigger, medium:channel, subject, body, version')
        .eq('locale', locale)
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
export function useSaveTemplate(orgId: string, queueId?: string, locale: TemplateLocale = 'en') {
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
            locale,
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

/** An SMS as the guest receives it: the locked frame around the tenant's middle, measured as a whole. */
export interface SmsPreview {
  /** The business name the database puts first; not editable. */
  prefix: string;
  /** The tenant's middle with sample values filled in. */
  body: string;
  /** The opt-out line the database puts last; not editable. */
  footer: string;
  segments: number;
  encoding: 'gsm7' | 'ucs2';
  /** draft for a typed body; otherwise default, custom, or custom_other_locale (an override in another language). */
  source: 'draft' | 'default' | 'custom' | 'custom_other_locale';
}

/**
 * api.sms_preview: the final text of an SMS from the database, never re-derived here. With `body`
 * undefined, previews what guests of `locale` get today. Null when no SMS template exists.
 */
export function useSmsPreview(
  orgId: string,
  trigger: string,
  locale: TemplateLocale,
  body?: string,
  enabled = true,
) {
  return useQuery({
    queryKey: ['admin', 'sms-preview', orgId, trigger, locale, body ?? null],
    enabled,
    placeholderData: keepPreviousData,
    queryFn: async (): Promise<SmsPreview | null> => {
      const { data, error } = await supabase.rpc('sms_preview', {
        p_org_id: orgId,
        p_trigger: trigger,
        p_locale: locale,
        ...(body === undefined ? {} : { p_body: body }),
      });
      if (error) throw new Error(errorCode(error));
      const row = data[0];
      return row ? (row as SmsPreview) : null;
    },
  });
}

/** The signed-in member's own phone in this org, for test texts. Null when none is saved. */
export interface MemberPhone {
  phone: string;
  verified: boolean;
}

const memberPhoneKey = (orgId: string) => ['admin', 'member-phone', orgId] as const;

/** app.member_phones: RLS returns only the caller's own row. */
export function useMemberPhone(orgId: string) {
  return useQuery({
    queryKey: memberPhoneKey(orgId),
    queryFn: async (): Promise<MemberPhone | null> => {
      const { data, error } = await supabase
        .schema('app')
        .from('member_phones')
        .select('phone_e164, verified_at')
        .eq('org_id', orgId)
        .maybeSingle();
      if (error) throw new Error(errorCode(error));
      return data ? { phone: data.phone_e164, verified: data.verified_at !== null } : null;
    },
  });
}

/** api.start_member_phone: saves the number and texts it a code. Rejects with the error code. */
export function useStartMemberPhone(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (phone: string) => {
      const { error } = await supabase.rpc('start_member_phone', {
        p_org_id: orgId,
        p_phone: phone,
      });
      if (error) throw new Error(errorCode(error));
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: memberPhoneKey(orgId) }),
  });
}

/** api.confirm_member_phone: true when the code matched. Rejects with `code_expired` or `not_found`. */
export function useConfirmMemberPhone(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (code: string): Promise<boolean> => {
      const { data, error } = await supabase.rpc('confirm_member_phone', {
        p_org_id: orgId,
        p_code: code,
      });
      if (error) throw new Error(errorCode(error));
      return data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: memberPhoneKey(orgId) }),
  });
}

/** api.send_member_test_sms: queues the saved text for `trigger` to the member's confirmed phone. */
export function useSendTestSms(orgId: string) {
  return useMutation({
    mutationFn: async (trigger: string) => {
      const { error } = await supabase.rpc('send_member_test_sms', {
        p_org_id: orgId,
        p_trigger: trigger,
      });
      if (error) throw new Error(errorCode(error));
    },
  });
}
