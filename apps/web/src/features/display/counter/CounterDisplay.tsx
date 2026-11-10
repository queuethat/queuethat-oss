import { errorCode } from '@qm/domain';
import { useSession } from '../../auth/api.ts';
import { useWakeLock } from '../useWakeLock.ts';
import { useCounterSnapshot } from './api.ts';
import { CounterView } from './CounterView.tsx';

/**
 * `/display/counter`: the paired display's own counter, live. The screen stays on; an unassigned
 * display says so instead of guessing a counter.
 */
export function CounterDisplay() {
  const { data: session } = useSession();
  const locationId = session?.user.app_metadata?.location_id as string | undefined;
  const snapshot = useCounterSnapshot(locationId);
  useWakeLock();
  return (
    <CounterView
      snapshot={snapshot.data}
      failed={snapshot.isError}
      unbound={!!snapshot.error && errorCode(snapshot.error) === 'not_found'}
    />
  );
}
