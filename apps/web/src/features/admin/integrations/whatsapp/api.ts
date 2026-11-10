import { errorCode } from '@qm/domain';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { appConfig } from '../../../../lib/config.ts';
import { supabase } from '../../../../lib/supabase.ts';

/** Only owners and admins change mappings; staff and managers see them read-only. */
export const canManageWhatsApp = (role: string | undefined) => role === 'admin' || role === 'owner';

export type WaStatus = 'pending' | 'approved' | 'rejected' | 'paused';
export type WaCategory = 'utility' | 'marketing';

export interface WhatsAppRow {
  templateId: string;
  trigger: string;
  locale: string;
  category: string;
  mapping: {
    id: string;
    name: string;
    language: string;
    category: WaCategory;
    status: WaStatus;
    syncedAt: string | null;
  } | null;
}

const whatsappKey = (orgId: string) => ['admin', 'whatsapp', orgId];

/** The org's WhatsApp notification templates, each with its Meta template mapping (if any). */
export const whatsappQuery = (orgId: string) =>
  queryOptions({
    queryKey: whatsappKey(orgId),
    queryFn: async (): Promise<WhatsAppRow[]> => {
      const app = supabase.schema('app');
      const [templates, mappings] = await Promise.all([
        app
          .from('notification_templates')
          .select('id, trigger, locale, category')
          .eq('org_id', orgId)
          .eq('channel', 'whatsapp')
          .order('trigger'),
        app
          .from('whatsapp_templates')
          .select('id, template_id, wa_name, wa_language, wa_category, status, synced_at')
          .eq('org_id', orgId),
      ]);
      if (templates.error) throw new Error(errorCode(templates.error));
      if (mappings.error) throw new Error(errorCode(mappings.error));
      return templates.data.map((t) => {
        const m = mappings.data.find((x) => x.template_id === t.id);
        return {
          templateId: t.id,
          trigger: t.trigger,
          locale: t.locale,
          category: t.category,
          mapping: m
            ? {
                id: m.id,
                name: m.wa_name,
                language: m.wa_language,
                category: m.wa_category as WaCategory,
                status: m.status as WaStatus,
                syncedAt: m.synced_at,
              }
            : null,
        };
      });
    },
  });

/** Maps a template to a Meta template. Errors: `category_mismatch`, `invalid_template`, `permission_denied`. */
export function useMapTemplate(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      templateId: string;
      name: string;
      language: string;
      category: WaCategory;
    }) => {
      const { error } = await supabase.schema('app').from('whatsapp_templates').insert({
        org_id: orgId,
        template_id: input.templateId,
        wa_name: input.name.trim(),
        wa_language: input.language.trim(),
        wa_category: input.category,
      });
      if (error)
        throw new Error(
          error.message.includes('category_mismatch') ? 'category_mismatch' : errorCode(error),
        );
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: whatsappKey(orgId) }),
  });
}

export function useRemoveMapping(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (mappingId: string) => {
      const { error } = await supabase
        .schema('app')
        .from('whatsapp_templates')
        .delete()
        .eq('id', mappingId);
      if (error) throw new Error(errorCode(error));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: whatsappKey(orgId) }),
  });
}

/** whatsapp-templates-sync POST. Errors: `not_configured`, `unavailable`. */
export function useSyncTemplates(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { data: session } = await supabase.auth.getSession();
      const res = await fetch(`${appConfig().supabaseUrl}/functions/v1/whatsapp-templates-sync`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.session?.access_token ?? ''}`,
        },
        body: JSON.stringify({ org_id: orgId }),
      });
      if (!res.ok) {
        const code = ((await res.json().catch(() => ({}))) as { error?: string }).error;
        throw new Error(code === 'not_configured' || code === 'unavailable' ? code : 'unknown');
      }
      return (await res.json()) as { updated: number; missing: number };
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: whatsappKey(orgId) }),
  });
}
