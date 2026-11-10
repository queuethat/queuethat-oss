import { useQuery } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase.ts';

export type PaperWidth = 58 | 80;

export interface PrintSettings {
  paper: PaperWidth;
  footer: string | null;
}

const DEFAULTS: PrintSettings = { paper: 80, footer: null };

/**
 * The location's thermal-ticket paper width and footer (2B-D3). Staff and paired devices read
 * their own location row under RLS. Until it loads, or if it fails, slips print at 80 mm with no
 * footer rather than not at all.
 */
export function usePrintSettings(locationId: string | undefined): PrintSettings {
  const { data } = useQuery({
    queryKey: ['printing', 'settings', locationId],
    enabled: !!locationId,
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<PrintSettings> => {
      const { data, error } = await supabase
        .schema('app')
        .from('locations')
        .select('print_paper_mm, print_footer')
        .eq('id', locationId ?? '')
        .single();
      if (error) throw error;
      return { paper: data.print_paper_mm === 58 ? 58 : 80, footer: data.print_footer };
    },
  });
  return data ?? DEFAULTS;
}
