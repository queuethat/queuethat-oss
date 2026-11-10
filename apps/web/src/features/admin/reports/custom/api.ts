import { errorCode } from '@qm/domain';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../../../lib/supabase.ts';

/** The fixed catalogue `api.run_report` accepts; the database rejects anything else. */
export const MEASURES = [
  'visits',
  'served',
  'avg_wait_min',
  'avg_service_min',
  'no_show_pct',
  'eta_error_min',
] as const;
export const DIMENSIONS = [
  'service_day',
  'hour',
  'weekday',
  'service',
  'queue',
  'location',
  'counter',
] as const;
export type Measure = (typeof MEASURES)[number];
export type Dimension = (typeof DIMENSIONS)[number];

export interface ReportDefinition {
  measures: Measure[];
  dimensions: Dimension[];
  /** Absent means every location the caller manages. */
  locationId?: string;
}

export interface ReportRow {
  dims: Partial<Record<Dimension, string | number>>;
  measures: Partial<Record<Measure, number | null>>;
}

export interface SavedReport extends ReportDefinition {
  id: string;
  name: string;
}

const wire = (orgId: string, d: ReportDefinition) => ({
  org_id: orgId,
  measures: d.measures,
  dimensions: d.dimensions,
  ...(d.locationId ? { filters: { location_id: d.locationId } } : {}),
});

/** `api.run_report`: aggregate rows for a definition over service days `from`..`to` (YYYY-MM-DD). */
export const runReportQuery = (orgId: string, d: ReportDefinition, from: string, to: string) =>
  queryOptions({
    queryKey: ['admin', 'custom-report', orgId, d, from, to] as const,
    queryFn: async (): Promise<ReportRow[]> => {
      const { data, error } = await supabase.rpc('run_report', {
        p_definition: wire(orgId, d),
        p_from: from,
        p_to: to,
      });
      if (error) throw new Error(errorCode(error));
      return data.map((c) => ({
        dims: (c.dims ?? {}) as ReportRow['dims'],
        measures: (c.measures ?? {}) as ReportRow['measures'],
      }));
    },
  });

const savedKey = (orgId: string) => ['admin', 'saved-reports', orgId] as const;

/** Saved definitions of the org (`app.report_definitions`, managers and above). */
export const savedReportsQuery = (orgId: string) =>
  queryOptions({
    queryKey: savedKey(orgId),
    queryFn: async (): Promise<SavedReport[]> => {
      const { data, error } = await supabase
        .schema('app')
        .from('report_definitions')
        .select('id, name, definition')
        .eq('org_id', orgId)
        .order('name');
      if (error) throw new Error(errorCode(error));
      return data.map((r) => {
        const def = r.definition as {
          measures: Measure[];
          dimensions?: Dimension[];
          filters?: { location_id?: string };
        };
        return {
          id: r.id,
          name: r.name,
          measures: def.measures,
          dimensions: def.dimensions ?? [],
          locationId: def.filters?.location_id,
        };
      });
    },
  });

/** Saves the definition under a name. Errors: `invalid_report_definition`, `permission_denied`. */
export function useSaveReport(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ name, definition }: { name: string; definition: ReportDefinition }) => {
      const { org_id: _org, ...stored } = wire(orgId, definition);
      const { error } = await supabase
        .schema('app')
        .from('report_definitions')
        .insert({ org_id: orgId, name, definition: stored });
      if (error) throw new Error(errorCode(error));
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: savedKey(orgId) }),
  });
}
