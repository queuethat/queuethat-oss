import { errorCode } from '@qm/domain';
import { queryOptions } from '@tanstack/react-query';
import { supabase } from '../../../lib/supabase.ts';
import { rangeInstants, type AuditSearch } from './search.ts';

// #1133: the audit page's reads. One hook per RPC; the database decides who sees what (operators
// every row, support their own) and masks contact data before it leaves.

/** Rows per page. The RPC is asked for one more, to know whether there is a next page. */
export const AUDIT_PAGE = 50;

/** `api.platform_audit_row`: generated composite fields are all nullable; these are the real ones. */
export interface AuditRow {
  id: number;
  at: string;
  actor_id: string | null;
  actor_email: string | null;
  action: string;
  org_id: string | null;
  org_name: string | null;
  reason: string | null;
  support_grant_id: string | null;
  break_glass_reason: string | null;
  target: Record<string, unknown>;
}

function params(filter: AuditSearch) {
  const { from, to } = rangeInstants(filter);
  return {
    ...(filter.actor ? { p_actor: filter.actor } : {}),
    ...(filter.org ? { p_org_id: filter.org } : {}),
    ...(filter.action ? { p_action: filter.action } : {}),
    ...(from ? { p_from: from } : {}),
    ...(to ? { p_to: to } : {}),
  };
}

/** One page of the platform audit (`api.platform_audit_search`), newest first. */
export const auditQuery = (filter: AuditSearch) =>
  queryOptions({
    queryKey: ['platform', 'audit', filter],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('platform_audit_search', {
        ...params(filter),
        p_limit: AUDIT_PAGE + 1,
        ...(filter.after ? { p_after: Number(filter.after) } : {}),
      });
      if (error) throw new Error(errorCode(error));
      const rows = data as unknown as AuditRow[];
      return { rows: rows.slice(0, AUDIT_PAGE), hasMore: rows.length > AUDIT_PAGE };
    },
  });

export interface AuditExport {
  csv: string;
  rowCount: number;
  truncated: boolean;
  /** Pass as `after` to export the next part when `truncated`. */
  nextAfter: number | null;
}

/**
 * The filtered range as CSV (`api.platform_audit_export`). The database writes the audit row for
 * the export, at most 10,000 rows per call; `after` continues a truncated export.
 */
export async function exportAudit(filter: AuditSearch, after?: number): Promise<AuditExport> {
  const { data, error } = await supabase.rpc('platform_audit_export', {
    ...params(filter),
    ...(after ? { p_after: after } : {}),
  });
  if (error) throw new Error(errorCode(error));
  return {
    csv: data.csv ?? '',
    rowCount: data.row_count ?? 0,
    truncated: data.truncated ?? false,
    nextAfter: data.next_after ?? null,
  };
}

/** Saves text as a file through a temporary link. */
export function saveCsv(csv: string, name: string) {
  const url = URL.createObjectURL(new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}
