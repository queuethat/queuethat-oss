import { errorCode } from '@qm/domain';
import { useMutation } from '@tanstack/react-query';
import { appConfig } from '../../../lib/config.ts';
import { supabase } from '../../../lib/supabase.ts';

export type ExportFormat = 'csv' | 'jsonl';

export interface ExportResult {
  remainingToday: number;
}

/**
 * Starts an export with `api.begin_data_export`, then downloads the zip from the `export-data`
 * Edge Function with the signed-in user's own token. Rejects with Error(<error code>), e.g.
 * `rate_limited`, `mfa_required` or `permission_denied`.
 */
export function useDataExport() {
  return useMutation({
    mutationFn: async (format: ExportFormat): Promise<ExportResult> => {
      const { data: ticket, error } = await supabase.rpc('begin_data_export', {
        p_format: format,
        p_idempotency_key: crypto.randomUUID(),
      });
      if (error) throw new Error(errorCode(error));
      const { data: session } = await supabase.auth.getSession();
      const { supabaseUrl, supabaseAnonKey } = appConfig();
      const response = await fetch(`${supabaseUrl}/functions/v1/export-data`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.session?.access_token ?? ''}`,
          apikey: supabaseAnonKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ export_id: ticket.export_id }),
      });
      if (!response.ok) throw new Error('unknown');
      save(await response.blob(), filename(response));
      return { remainingToday: ticket.remaining_today ?? 0 };
    },
  });
}

function filename(response: Response): string {
  const match = /filename="([^"]+)"/.exec(response.headers.get('Content-Disposition') ?? '');
  return match?.[1] ?? 'export.zip';
}

function save(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}
