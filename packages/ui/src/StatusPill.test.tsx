import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { StatusPill, type VisitStatus } from './StatusPill.tsx';
import { TicketNumber } from './TicketNumber.tsx';

afterEach(cleanup);

const ALL: VisitStatus[] = [
  'expected',
  'waiting',
  'called',
  'serving',
  'served',
  'no_show',
  'cancelled',
  'removed',
  'expired',
];

describe('StatusPill', () => {
  it.each(ALL)('%s has a label and an icon, so colour is never the only signal', (status) => {
    const { container } = render(<StatusPill status={status}>Label</StatusPill>);
    expect(screen.getByText('Label')).toBeTruthy();
    expect(container.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
  });

  it('called has a thicker edge than the other states', () => {
    const { container } = render(
      <>
        <StatusPill status="called">Called</StatusPill>
        <StatusPill status="waiting">Waiting</StatusPill>
      </>,
    );
    const [called, waiting] = Array.from(container.querySelectorAll('span[data-status]'));
    expect(called?.className).toContain('border-2');
    expect(waiting?.className).not.toContain('border-2');
  });

  it('gives called and waiting different icons', () => {
    const { container } = render(
      <>
        <StatusPill status="called">Called</StatusPill>
        <StatusPill status="waiting">Waiting</StatusPill>
      </>,
    );
    const d = Array.from(container.querySelectorAll('path')).map((p) => p.getAttribute('d'));
    expect(d[0]).not.toBe(d[1]);
  });
});

describe('TicketNumber', () => {
  it('renders the ticket verbatim in mono tabular figures', () => {
    render(<TicketNumber ticket="A007" size="tv" />);
    const el = screen.getByText('A007');
    expect(el.className).toContain('font-mono');
    expect(el.className).toContain('tabular-nums');
    expect(el.className).toContain('text-display');
  });
});
