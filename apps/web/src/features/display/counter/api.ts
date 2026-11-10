import type { Database } from '@qm/db-types';
import { errorCode } from '@qm/domain';
import { queryOptions } from '@tanstack/react-query';
import { supabase } from '../../../lib/supabase.ts';
import { useLiveQuery } from '../../../lib/live.ts';

export type CounterSnapshot = Database['api']['CompositeTypes']['counter_snapshot'];

// 2B-D2 (#259): the counter display's one read, api.counter_display_snapshot (2B-D1). The
// database picks the counter from the device row, so nothing here names one.

async function fetchCounterSnapshot() {
  const { data, error } = await supabase.rpc('counter_display_snapshot');
  if (error) throw error;
  return data;
}

export const counterSnapshotQuery = () =>
  queryOptions({ queryKey: ['display', 'counter-snapshot'], queryFn: fetchCounterSnapshot });

/**
 * What this counter is serving. Refetched on every signal on the location's private topic, which
 * paired devices may follow, and every 30 s. Retries stop on `not_found`: an unbound display
 * stays unbound until an admin binds it, and the screen says so.
 */
export function useCounterSnapshot(locationId: string | undefined) {
  return useLiveQuery({
    queryKey: counterSnapshotQuery().queryKey,
    queryFn: fetchCounterSnapshot,
    topic: locationId ? `loc:${locationId}` : null,
    enabled: !!locationId,
    jitterMs: 0,
    retry: (failures, error) => errorCode(error) !== 'not_found' && failures < 3,
  });
}
