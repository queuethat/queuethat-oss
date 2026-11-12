import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadNamespaces } from '../../../lib/i18n.ts';
import type { ConsoleQueue, ConsoleVisit } from '../api.ts';
import { callableCount, hasLines, myLineIds } from './lines.ts';
import { LinesBoard } from './LinesBoard.tsx';

beforeAll(() => loadNamespaces('staff'));
afterEach(cleanup);

const line = (id: string, kind: ConsoleQueue['kind'], pullsFrom: string | null = null) =>
  ({ id, name: id, kind, pullsFrom }) as ConsoleQueue;
const visit = (queueId: string, ticket: string, status = 'waiting') =>
  ({ id: ticket, queueId, ticket, status, name: `Guest ${ticket}` }) as ConsoleVisit;

const pool = line('Anyone', 'pool');
const ana = line('Ana', 'provider', 'Anyone');
const ben = line('Ben', 'provider', 'Anyone');
const desk = line('Desk', 'general');
const queues = [ana, ben, pool];

describe('lines', () => {
  it('knows whether a location runs per-person lines', () => {
    expect(hasLines([desk])).toBe(false);
    expect(hasLines([desk, pool])).toBe(true);
  });

  it("a provider's lines are their own plus the pool it pulls from", () => {
    expect(myLineIds(queues, ['Ana'])).toEqual(['Ana', 'Anyone']);
    expect(myLineIds(queues, null)).toEqual([]);
    // A member limited to a general line has no line of their own here.
    expect(myLineIds([desk, ...queues], ['Desk'])).toEqual([]);
  });

  it('Call next on a provider line counts the pool too', () => {
    const visits = [visit('Anyone', 'P001'), visit('Ben', 'B001'), visit('Ana', 'A001', 'called')];
    expect(callableCount(ana, visits)).toBe(1);
    expect(callableCount(ben, visits)).toBe(2);
    expect(callableCount(pool, visits)).toBe(1);
    expect(callableCount(desk, visits)).toBe(0);
  });
});

describe('LinesBoard', () => {
  const props = {
    queues,
    visits: [visit('Anyone', 'P001'), visit('Ben', 'B001')],
    currentId: 'Ana',
    mayCall: true,
    disabled: false,
    calling: null,
    onOpen: vi.fn(),
  };

  it('shows a provider their line and the pool, and calls from the pool when theirs is empty', async () => {
    const onCallNext = vi.fn();
    render(
      <LinesBoard
        {...props}
        mine={{ queueIds: ['Ana'], restricted: false }}
        onCallNext={onCallNext}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Ana' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Anyone' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Ben' })).toBeNull();
    expect(
      within(screen.getByTestId('line-Ana')).getByText('Next comes from Anyone.'),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Call next for Ana' }));
    expect(onCallNext).toHaveBeenCalledWith('Ana');

    await userEvent.click(screen.getByRole('button', { name: 'All lines' }));
    expect(screen.getByRole('heading', { name: 'Ben' })).toBeTruthy();
    expect(within(screen.getByTestId('line-Ben')).getByText('B001')).toBeTruthy();
  });

  it('shows the front desk every line, with no view switch', () => {
    render(
      <LinesBoard {...props} mine={{ queueIds: null, restricted: false }} onCallNext={vi.fn()} />,
    );
    expect(screen.getAllByRole('heading', { level: 3 })).toHaveLength(3);
    expect(screen.queryByRole('button', { name: 'All lines' })).toBeNull();
  });

  it('keeps a scoped provider on their own lines', () => {
    render(
      <LinesBoard {...props} mine={{ queueIds: ['Ana'], restricted: true }} onCallNext={vi.fn()} />,
    );
    expect(screen.getAllByRole('heading', { level: 3 })).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'All lines' })).toBeNull();
  });

  it('renders nothing where no line is per person', () => {
    const { container } = render(
      <LinesBoard {...props} queues={[desk]} mine={undefined} onCallNext={vi.fn()} />,
    );
    expect(container.innerHTML).toBe('');
  });
});
