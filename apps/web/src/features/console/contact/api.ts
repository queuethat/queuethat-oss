import { useMutation } from '@tanstack/react-query';
import { supabase } from '../../../lib/supabase.ts';

/**
 * `api.log_manual_contact`: audits a staff tap on WhatsApp and returns the guest's E.164 phone for
 * the wa.me link, so the console never selects contact data. Errors: `no_contact`, `suppressed`
 * (opted out), `not_found`.
 */
export function useLogManualContact() {
  return useMutation({
    mutationFn: async (visitId: string): Promise<string> => {
      const { data, error } = await supabase.rpc('log_manual_contact', {
        p_visit_id: visitId,
        p_channel: 'whatsapp',
      });
      if (error) throw error;
      return data;
    },
  });
}
