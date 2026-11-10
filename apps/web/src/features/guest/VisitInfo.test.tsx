import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadNamespaces } from '../../lib/i18n.ts';
import { hoursSentence, VisitInfo } from './VisitInfo.tsx';

afterEach(cleanup);
beforeAll(() => loadNamespaces('guest-info')); // a lazy namespace, loaded with the card

const info = {
  location_name: 'Demo Barber',
  address: 'Main St 1, Berlin',
  phone: '+49 30 1234',
  directions_url: 'https://www.google.com/maps/search/?api=1&query=Main%20St%201%2C%20Berlin',
  hours_today: { open_now: true, next_change: '2030-01-15T20:00:00Z', tz: 'UTC' },
  service_name: null,
  scheduled_at: null,
  scan_code: '7K2M9P4X1Q',
  group_key: null,
  locale: 'en',
};

describe('VisitInfo', () => {
  it('links the address and phone, opening maps in a new context (AC1)', () => {
    render(<VisitInfo info={info} ticket="A042" />);
    const maps = screen.getByRole('link', { name: 'Get directions' });
    expect(maps.getAttribute('href')).toBe(info.directions_url);
    expect(maps.getAttribute('rel')).toBe('noopener noreferrer');
    expect(screen.getByRole('link', { name: 'Call +49 30 1234' }).getAttribute('href')).toBe(
      'tel:+49301234',
    );
  });

  it('says nothing about hours when none are configured (AC2)', () => {
    render(
      <VisitInfo
        info={{ ...info, hours_today: { open_now: true, next_change: null, tz: 'UTC' } }}
        ticket="A042"
      />,
    );
    expect(screen.queryByTestId('hours')).toBeNull();
  });

  it('shows no calendar button without a scheduled time (AC2 of #127) and one with it', () => {
    const { rerender } = render(<VisitInfo info={info} ticket="A042" />);
    expect(screen.queryByRole('button', { name: 'Add to calendar' })).toBeNull();
    rerender(<VisitInfo info={{ ...info, scheduled_at: '2030-01-15T13:30:00Z' }} ticket="A042" />);
    expect(screen.getByRole('button', { name: 'Add to calendar' })).toBeTruthy();
  });

  it('hides the About card when there is nothing to put in it', () => {
    render(
      <VisitInfo
        info={{ ...info, address: null, phone: null, directions_url: null, hours_today: null }}
        ticket="A042"
      />,
    );
    expect(screen.queryByText('About this place')).toBeNull();
  });
});

describe('hoursSentence', () => {
  const t = (key: string, vars?: Record<string, unknown>) => `${key} ${JSON.stringify(vars)}`;
  const now = Date.parse('2030-01-15T10:00:00Z');

  it('says when an open place closes, in its own timezone', () => {
    const s = hoursSentence(
      { open_now: true, next_change: '2030-01-15T20:00:00Z', tz: 'Europe/Berlin' },
      now,
      'en',
      t,
    );
    expect(s).toContain('info.openUntil ');
    expect(s).toContain('9:00');
  });

  it('adds the weekday when the change is not today', () => {
    const s = hoursSentence(
      { open_now: false, next_change: '2030-01-17T08:00:00Z', tz: 'UTC' },
      now,
      'en',
      t,
    );
    expect(s).toContain('info.opensAtLater');
    expect(s).toContain('Thursday');
  });
});
