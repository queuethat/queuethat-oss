import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { DataTable } from './DataTable.tsx';

afterEach(cleanup);

interface Row {
  id: number;
  name: string;
  wait: string;
}
const rows: Row[] = [
  { id: 1, name: 'Ana', wait: '5 min' },
  { id: 2, name: 'Ben', wait: '9 min' },
];
const columns = [
  { id: 'name', header: 'Guest', cell: (r: Row) => r.name },
  { id: 'wait', header: 'Wait', cell: (r: Row) => r.wait, align: 'end' as const },
];

describe('DataTable', () => {
  it('is a named table with column headers and one row per item', () => {
    render(<DataTable label="Guests" columns={columns} rows={rows} getRowKey={(r) => r.id} />);
    const table = screen.getByRole('table', { name: 'Guests' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['Guest', 'Wait']);
    expect(within(table).getAllByRole('row')).toHaveLength(3);
    expect(within(table).getByRole('cell', { name: 'Ana' })).toBeTruthy();
  });

  it('labels every cell with its column heading for the stacked layout', () => {
    render(<DataTable label="Guests" columns={columns} rows={rows} getRowKey={(r) => r.id} />);
    const labels = screen.getAllByRole('cell').map((c) => c.getAttribute('data-label'));
    expect(labels).toEqual(['Guest', 'Wait', 'Guest', 'Wait']);
  });

  it('stacks below 640px: the header stays for assistive tech, rows become cards', () => {
    render(<DataTable label="Guests" columns={columns} rows={rows} getRowKey={(r) => r.id} />);
    expect(screen.getByRole('table').className).toContain('max-sm:block');
    expect(screen.getAllByRole('rowgroup')[0]?.className).toContain('max-sm:sr-only');
    expect(screen.getAllByRole('row')[1]?.className).toContain('max-sm:block');
  });

  it('shows the empty state instead of an empty table', () => {
    render(
      <DataTable
        label="Guests"
        columns={columns}
        rows={[]}
        getRowKey={(r: Row) => r.id}
        empty={<p>Nobody yet</p>}
      />,
    );
    expect(screen.getByText('Nobody yet')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('wraps in a focusable scroll region only when asked', () => {
    const { rerender } = render(
      <DataTable label="Guests" columns={columns} rows={rows} getRowKey={(r) => r.id} />,
    );
    expect(screen.queryByRole('region')).toBeNull();
    rerender(
      <DataTable
        label="Guests"
        scrollLabel="Guests, scrollable"
        columns={columns}
        rows={rows}
        getRowKey={(r) => r.id}
      />,
    );
    expect(screen.getByRole('region', { name: 'Guests, scrollable' }).tabIndex).toBe(0);
  });
});
