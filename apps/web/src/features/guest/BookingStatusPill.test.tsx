import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { BookingStatusPill } from './BookingStatusPill.tsx';

afterEach(cleanup);

describe('BookingStatusPill', () => {
  it.each([
    ['booked', 'waiting'],
    ['pending_payment', 'called'],
    ['offered', 'called'],
    ['claimed', 'serving'],
    ['completed', 'serving'],
    ['no_show', 'no_show'],
    ['cancelled', 'cancelled'],
    ['expired', 'expired'],
  ])('%s wears the %s look', (status, look) => {
    render(<BookingStatusPill status={status}>Label</BookingStatusPill>);
    expect(screen.getByText('Label').closest('[data-status]')!.getAttribute('data-status')).toBe(
      look,
    );
  });

  it('falls back to the waiting look for a status it does not know', () => {
    render(<BookingStatusPill status="something_new">Label</BookingStatusPill>);
    expect(screen.getByText('Label').closest('[data-status]')!.getAttribute('data-status')).toBe(
      'waiting',
    );
  });
});
