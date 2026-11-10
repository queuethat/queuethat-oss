import { useState } from 'react';
import type { ActiveState, ConsoleVisit } from '../api.ts';

/** What the filter chips select. Within one group any chip matches; across groups all must. */
export interface Filters {
  services: string[];
  statuses: ActiveState[];
  tags: string[];
  /** Only guests assigned to me or to my counter (Q-18). */
  mine: boolean;
}

export const NO_FILTERS: Filters = { services: [], statuses: [], tags: [], mine: false };

/** Who "mine" means: this signed-in person and the counter this tablet serves from. */
export interface Me {
  userId: string | undefined;
  counterId: string | null;
}

export function isFiltering(f: Filters): boolean {
  return f.services.length + f.statuses.length + f.tags.length > 0 || f.mine;
}

/** The visits that pass `f`. Pure and applied to the already-loaded live list. */
export function applyFilters(visits: ConsoleVisit[], f: Filters, me?: Me): ConsoleVisit[] {
  return visits.filter(
    (v) =>
      (!f.mine ||
        (me?.userId !== undefined && v.assignedStaffId === me.userId) ||
        (me?.counterId != null && v.assignedCounterId === me.counterId)) &&
      (f.services.length === 0 || (v.service !== null && f.services.includes(v.service))) &&
      (f.statuses.length === 0 || f.statuses.includes(v.status)) &&
      (f.tags.length === 0 || v.tags.some((tag) => f.tags.includes(tag))),
  );
}

/** Adds `value` to `list`, or removes it when already there. */
export function toggle<T>(list: readonly T[], value: T): T[] {
  return list.includes(value) ? list.filter((x) => x !== value) : [...list, value];
}

// Filters belong to the tablet, like "my counter": one choice per location.
const key = (locationId: string) => `qm.console.filters:${locationId}`;

function read(locationId: string): Filters {
  try {
    const raw = JSON.parse(
      window.localStorage.getItem(key(locationId)) ?? 'null',
    ) as Partial<Filters> | null;
    return {
      services: Array.isArray(raw?.services) ? raw.services.map(String) : [],
      statuses: Array.isArray(raw?.statuses) ? (raw.statuses.map(String) as ActiveState[]) : [],
      tags: Array.isArray(raw?.tags) ? raw.tags.map(String) : [],
      mine: raw?.mine === true,
    };
  } catch {
    return NO_FILTERS;
  }
}

/** The filters of this tablet at `locationId`, remembered across reloads (storage may be blocked). */
export function useFilters(locationId: string | undefined) {
  const [state, setState] = useState<{ locationId: string | undefined; filters: Filters }>(() => ({
    locationId,
    filters: locationId ? read(locationId) : NO_FILTERS,
  }));
  // The location is known only after sign-in: pick up its stored filters once it appears.
  const filters =
    state.locationId === locationId ? state.filters : locationId ? read(locationId) : NO_FILTERS;
  const set = (next: Filters) => {
    setState({ locationId, filters: next });
    if (!locationId) return;
    try {
      window.localStorage.setItem(key(locationId), JSON.stringify(next));
    } catch {
      // Private mode: the filters last until reload.
    }
  };
  return [filters, set] as const;
}
