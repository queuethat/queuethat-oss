import { errorCode } from '@qm/domain';
import { useMutation } from '@tanstack/react-query';
import { supabase } from '../../../../lib/supabase.ts';

export interface GuestMatch {
  id: string;
  name: string | null;
  visitCount: number;
  lastVisitAt: string | null;
}

export interface ErasureResult {
  visitsAnonymized: number;
  contactsDeleted: number;
}

/** What the person typed: an email when it has an `@`, otherwise a phone number. */
export const isEmail = (text: string) => text.includes('@');

/**
 * `api.find_guest_data`: guests holding exactly this phone or email, in businesses where the
 * caller is owner or admin. Errors: `invalid_input`.
 */
export function useFindGuest() {
  return useMutation({
    mutationFn: async (text: string): Promise<GuestMatch[]> => {
      const query = text.trim();
      const { data, error } = await supabase.rpc('find_guest_data', {
        // The function reads null as "not searching by this"; the types say string.
        p_phone_e164: (isEmail(query) ? null : query) as string,
        p_email: (isEmail(query) ? query : null) as string,
      });
      if (error) throw new Error(errorCode(error));
      return data.map((g) => ({
        id: g.guest_id!,
        name: g.name,
        visitCount: g.visit_count ?? 0,
        lastVisitAt: g.last_visit_at,
      }));
    },
  });
}

/** `api.export_guest_data`: the sections as JSON. Errors: `not_found`, `mfa_required`. */
export function useExportGuest() {
  return useMutation({
    mutationFn: async (guestId: string): Promise<unknown> => {
      const { data, error } = await supabase.rpc('export_guest_data', { p_guest_id: guestId });
      if (error) throw new Error(errorCode(error));
      return data;
    },
  });
}

/** `api.erase_guest`: irreversible. Errors: `not_found`, `mfa_required`, `invalid_input`. */
export function useEraseGuest() {
  return useMutation({
    mutationFn: async (input: {
      guestId: string;
      reason: string;
      keepSuppression: boolean;
    }): Promise<ErasureResult> => {
      const { data, error } = await supabase.rpc('erase_guest', {
        p_guest_id: input.guestId,
        p_reason: input.reason.trim(),
        p_keep_suppression: input.keepSuppression,
        p_idempotency_key: crypto.randomUUID(),
      });
      if (error) throw new Error(errorCode(error));
      return {
        visitsAnonymized: data.visits_anonymized ?? 0,
        contactsDeleted: data.contacts_deleted ?? 0,
      };
    },
  });
}

/** Saves `data` as a JSON file named `name` through a temporary link. */
export function downloadJson(name: string, data: unknown) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}
