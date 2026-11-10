import { useCallback, useEffect, useMemo, useState } from 'react';
import { appConfig } from '../../../lib/config.ts';
import { useNow } from '../../../lib/now.ts';
import type { ConsoleQueue, ConsoleVisit } from '../api.ts';
import { overdueVisits, SNOOZE_MS, type Overdue } from './threshold.ts';

const STORAGE_KEY = 'qm.servingSnooze';

function readSnoozes(): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, number>) : {};
  } catch {
    return {};
  }
}

function writeSnoozes(map: Record<string, number>, now: number) {
  const live = Object.fromEntries(Object.entries(map).filter(([, until]) => until > now));
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(live));
  } catch {
    // Private mode: the snooze then lasts for this page load only.
  }
  return live;
}

/**
 * Milliseconds to add to this tablet's clock to get server time, from the `Date` response header
 * of one cheap request. 0 until it arrives, or where the browser hides the header.
 */
export function useServerOffset(): number {
  const [offset, setOffset] = useState(0);
  useEffect(() => {
    const { supabaseUrl, supabaseAnonKey } = appConfig();
    const sent = Date.now();
    fetch(`${supabaseUrl}/rest/v1/`, { method: 'HEAD', headers: { apikey: supabaseAnonKey } })
      .then((res) => {
        const date = res.headers.get('date');
        if (!date) return;
        const mid = (sent + Date.now()) / 2;
        setOffset(new Date(date).getTime() - mid);
      })
      .catch(() => undefined);
  }, []);
  return offset;
}

/**
 * Serving visits that have run past their threshold (#144), measured on server time, minus the
 * ones this tablet snoozed. `snooze` hides one for 15 minutes on this tablet only.
 */
export function useServingReminders(
  visits: ConsoleVisit[] | undefined,
  queues: ConsoleQueue[] | undefined,
): { overdue: Overdue[]; snooze: (id: string) => void } {
  const offset = useServerOffset();
  const tablet = useNow(15_000);
  const now = tablet + offset;
  const [snoozes, setSnoozes] = useState(readSnoozes);
  const overdue = useMemo(
    () =>
      overdueVisits(
        visits ?? [],
        (queueId) => queues?.find((q) => q.id === queueId)?.servingReminderMinutes ?? null,
        now,
        snoozes,
      ),
    [visits, queues, now, snoozes],
  );
  const snooze = useCallback(
    (id: string) =>
      setSnoozes((s) =>
        writeSnoozes({ ...s, [id]: Date.now() + offset + SNOOZE_MS }, Date.now() + offset),
      ),
    [offset],
  );
  return { overdue, snooze };
}
