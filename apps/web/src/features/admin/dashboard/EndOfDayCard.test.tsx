import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadNamespaces } from '../../../lib/i18n.ts';
import { EndOfDayCard } from './EndOfDayCard.tsx';

beforeAll(() => loadNamespaces('admin'));
afterEach(cleanup);

const stats = {
  location_id: 'l',
  service_day: '2026-11-02',
  waiting_now: 0,
  served: 14,
  no_shows: 2,
  cancelled: 3,
  avg_wait_minutes: 11.5,
  longest_wait_minutes: 42,
  busiest_hour: '2026-11-02T17:00:00Z',
  as_of: '2026-11-02T20:00:00Z',
  joined: 20,
};

describe('EndOfDayCard', () => {
  it('shows the five figures as the database returned them', () => {
    render(<EndOfDayCard stats={stats} timeZone="America/New_York" />);
    expect(screen.getByTestId('eod-served').textContent).toMatch(/14/);
    expect(screen.getByTestId('eod-left').textContent).toMatch(/2 \/ 3/);
    expect(screen.getByTestId('eod-avgWait').textContent).toMatch(/11\.5 min/);
    expect(screen.getByTestId('eod-longestWait').textContent).toMatch(/42 min/);
    // 17:00Z is noon in New York in November.
    expect(screen.getByTestId('eod-busiestHour').textContent).toMatch(/12\s?PM/);
  });

  it('formats the hour in the location time zone, not the browser', () => {
    render(<EndOfDayCard stats={stats} timeZone="Europe/Berlin" />);
    expect(screen.getByTestId('eod-busiestHour').textContent).toMatch(/6\s?PM/);
  });

  it('shows an empty state when nobody was served', () => {
    render(<EndOfDayCard stats={{ ...stats, served: 0 }} timeZone="UTC" />);
    expect(screen.queryByTestId('eod-served')).toBeNull();
    expect(screen.getByText(/Nobody has been served yet/)).toBeTruthy();
  });
});
