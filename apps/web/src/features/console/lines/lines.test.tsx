import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadNamespaces } from '../../../lib/i18n.ts';
import type { ConsoleQueue, ConsoleVisit } from '../api.ts';
import { callableCount, hasLines, lineVisits, myLineIds } from './lines.ts';
import { LinesToggle, useLineView } from './LinesBoard.tsx';
import type { MyLines } from './api.ts';

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

  it("a provider's tab lists its own guests and its pool's, including the pool's called ones (#80)", () => {
    const visits = [
      visit('Anyone', 'P001', 'called'),
      visit('Ana', 'A001'),
      visit('Anyone', 'P002'),
      visit('Ben', 'B001'),
    ];
    expect(lineVisits(ana, visits).map((v) => v.ticket)).toEqual(['P001', 'A001', 'P002']);
    expect(lineVisits(pool, visits).map((v) => v.ticket)).toEqual(['P001', 'P002']);
    expect(lineVisits(desk, visits)).toEqual([]);
    expect(lineVisits(undefined, visits)).toEqual([]);
  });
});

function Harness({ qs = queues, mine }: { qs?: ConsoleQueue[]; mine: MyLines | undefined }) {
  const { shown, view, setChoice, canSwitch } = useLineView(qs, mine);
  return (
    <>
      <LinesToggle view={view} canSwitch={canSwitch} onChoose={setChoice} />
      <ul>
        {shown.map((q) => (
          <li key={q.id}>{q.name}</li>
        ))}
      </ul>
    </>
  );
}
const names = () => screen.queryAllByRole('listitem').map((li) => li.textContent);

describe('line tabs', () => {
  it('shows a provider their line and the pool, and every line on request', async () => {
    render(<Harness mine={{ queueIds: ['Ana'], restricted: false }} />);
    expect(names()).toEqual(['Ana', 'Anyone']);
    await userEvent.click(screen.getByRole('button', { name: 'All lines' }));
    expect(names()).toEqual(['Ana', 'Ben', 'Anyone']);
    await userEvent.click(screen.getByRole('button', { name: 'My lines' }));
    expect(names()).toEqual(['Ana', 'Anyone']);
  });

  it('shows the front desk every line, with no view switch', () => {
    render(<Harness mine={{ queueIds: null, restricted: false }} />);
    expect(names()).toHaveLength(3);
    expect(screen.queryByRole('button', { name: 'All lines' })).toBeNull();
  });

  it('keeps a scoped provider on their own lines', () => {
    render(<Harness mine={{ queueIds: ['Ana'], restricted: true }} />);
    expect(names()).toEqual(['Ana', 'Anyone']);
    expect(screen.queryByRole('button', { name: 'All lines' })).toBeNull();
  });

  it('leaves a location without per-person lines alone', () => {
    render(<Harness qs={[desk]} mine={undefined} />);
    expect(names()).toEqual(['Desk']);
    expect(screen.queryByRole('group')).toBeNull();
  });
});
