import { errorCode } from '@qm/domain';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../../../lib/supabase.ts';

/** One accepted agreement in an export; the guest name is the visit's or the appointment's. */
export interface WaiverExportRow {
  acceptedAt: string;
  signedAt: string | null;
  form: string;
  version: number;
  agreement: string;
  textHash: string;
  typedName: string | null;
  guardianName: string | null;
  guestName: string | null;
  subject: 'visit' | 'appointment';
}

export interface WaiverExport {
  timezone: string;
  rows: WaiverExportRow[];
  truncated: boolean;
}

interface Raw {
  timezone: string;
  truncated: boolean;
  rows: {
    accepted_at: string;
    signed_at: string | null;
    form_name: string;
    form_version: number;
    agreement: string | null;
    text_hash: string;
    typed_name: string | null;
    guardian_name: string | null;
    guest_name: string | null;
    subject_kind: 'visit' | 'appointment';
  }[];
}

/**
 * Fetches the location's waiver records for a local date range with `api.export_waiver_records`
 * (managers and above; the database logs every call). Rejects with Error(<error code>).
 */
export function useExportWaivers(locationId: string) {
  return useMutation({
    mutationFn: async (range: { from: string; to: string }): Promise<WaiverExport> => {
      const { data, error } = await supabase.rpc('export_waiver_records', {
        p_location_id: locationId,
        p_from: range.from,
        p_to: range.to,
      });
      if (error) throw new Error((error as { message?: string }).message ?? 'unknown');
      const raw = data as unknown as Raw;
      return {
        timezone: raw.timezone,
        truncated: raw.truncated,
        rows: raw.rows.map((r) => ({
          acceptedAt: r.accepted_at,
          signedAt: r.signed_at,
          form: r.form_name,
          version: r.form_version,
          agreement: r.agreement ?? '',
          textHash: r.text_hash,
          typedName: r.typed_name,
          guardianName: r.guardian_name,
          guestName: r.guest_name,
          subject: r.subject_kind,
        })),
      };
    },
  });
}

export const WAIVER_RETENTION_MIN = 1;
/** Seven years. The database enforces it; this gives early feedback. */
export const WAIVER_RETENTION_MAX = 2555;

const retentionKey = (orgId: string) => ['admin', 'waiver-retention', orgId] as const;

/** Days waiver records are kept, the organisation's own setting (default 365). */
export const waiverRetentionQuery = (orgId: string) =>
  queryOptions({
    queryKey: retentionKey(orgId),
    queryFn: async (): Promise<number> => {
      const { data, error } = await supabase
        .schema('app')
        .from('organizations')
        .select('waiver_retention_days')
        .eq('id', orgId)
        .single();
      if (error) throw error;
      return data.waiver_retention_days;
    },
  });

/** Sets the waiver retention. Admins and owners only: RLS hides the row from anyone else. */
export function useSetWaiverRetention(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (days: number) => {
      const { data, error } = await supabase
        .schema('app')
        .from('organizations')
        .update({ waiver_retention_days: days })
        .eq('id', orgId)
        .select('id');
      if (error) throw new Error(errorCode(error));
      if (data.length === 0) throw new Error('permission_denied');
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: retentionKey(orgId) }),
  });
}
