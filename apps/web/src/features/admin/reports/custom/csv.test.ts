import { describe, expect, it } from 'vitest';
import { reportCsv } from './csv.ts';

describe('reportCsv', () => {
  it('writes dimension columns then measure columns, quoting commas and blanks for null', () => {
    const rows = [
      { dims: { queue: 'Cuts, fast' }, measures: { visits: 3, avg_wait_min: null } },
      { dims: { queue: 'Color' }, measures: { visits: 1, avg_wait_min: 4.5 } },
    ];
    const csv = reportCsv(
      rows,
      { queue: 'Queue', visits: 'Visits', avg_wait_min: 'Wait' },
      (r, d) => String(r.dims[d]),
    );
    expect(csv).toBe('Queue,Visits,Wait\r\n"Cuts, fast",3,\r\nColor,1,4.5\r\n');
  });
});
