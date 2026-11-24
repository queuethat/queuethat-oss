import { errorCode } from '@qm/domain';
import { queryOptions } from '@tanstack/react-query';
import { supabase } from '../../../lib/supabase.ts';

/** The triggers an owner can reword; the database refuses anything else (`invalid_trigger`). */
/** The wording guests are sent. Reading it is core; editing it is ee/web/src/templates. */
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
