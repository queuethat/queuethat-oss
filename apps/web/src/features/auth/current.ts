import { useQuery } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import { locationsQuery, membershipsQuery, useSession } from './api.ts';

// Which location this browser works at. Kept per device (a tablet belongs to one place), and
// validated against what RLS lets the user see, so a stale id falls back to the first location.
const KEY = 'qm.location';
const listeners = new Set<() => void>();

function readSelected(): string | null {
  try {
    return window.localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

/** Remembers `locationId` as this browser's current location. */
export function selectLocation(locationId: string) {
  try {
    window.localStorage.setItem(KEY, locationId);
  } catch {
    // Private mode: the choice lasts until reload.
  }
  listeners.forEach((notify) => notify());
}

function subscribe(notify: () => void) {
  listeners.add(notify);
  return () => listeners.delete(notify);
}

/**
 * The location staff are working at, plus every location they could switch to. `location` is
 * undefined only while loading. Use inside `/staff` or `/admin`, whose guard ensures a membership.
 */
export function useCurrentLocation() {
  const userId = useSession().data?.user.id ?? '';
  const selected = useSyncExternalStore(subscribe, readSelected, () => null);
  const { data: locations = [] } = useQuery({ ...locationsQuery(userId), enabled: !!userId });
  const location = locations.find((l) => l.id === selected) ?? locations[0];
  return { location, locations };
}

/** The organization that owns the current location, with the user's role in it. */
export function useCurrentOrg() {
  const userId = useSession().data?.user.id ?? '';
  const { location } = useCurrentLocation();
  const { data: memberships = [] } = useQuery({ ...membershipsQuery(userId), enabled: !!userId });
  const membership = memberships.find((m) => m.org_id === location?.org_id) ?? memberships[0];
  return membership
    ? { id: membership.org_id, name: membership.organizations?.name ?? '', role: membership.role }
    : undefined;
}
