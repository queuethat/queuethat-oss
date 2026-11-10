import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderPicker } from './ProviderPicker.tsx';

afterEach(cleanup);

const line = {
  queue_id: 'a',
  name: 'Ana',
  kind: 'provider',
  accepting: true,
  not_accepting_reason: null,
  waiting_count: 2,
  eta_state: 'ok' as const,
  eta_low: 10,
  eta_high: 20,
  selected: false,
};
const lines = [
  { ...line, queue_id: 'p', name: 'Pool queue', kind: 'pool', waiting_count: 0 },
  line,
  { ...line, queue_id: 'b', name: 'Ben', accepting: false, not_accepting_reason: 'paused' },
];

describe('ProviderPicker', () => {
  it('lists Anyone available first, then people, with their waits', () => {
    render(<ProviderPicker lines={lines} value="p" onChange={() => {}} />);
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(3);
    expect(screen.getByText('Anyone available')).toBeTruthy();
    expect(screen.queryByText('Pool queue')).toBeNull();
    expect(screen.getByText('About 10–20 min, 2 waiting')).toBeTruthy();
  });

  it('disables a line that is not accepting and says why', () => {
    render(<ProviderPicker lines={lines} value="p" onChange={() => {}} />);
    expect((screen.getByRole('radio', { name: /Ben/ }) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(/paused/i)).toBeTruthy();
  });

  it('reports the chosen line', () => {
    const onChange = vi.fn();
    render(<ProviderPicker lines={lines} value="p" onChange={onChange} />);
    fireEvent.click(screen.getByRole('radio', { name: /Ana/ }));
    expect(onChange).toHaveBeenCalledWith('a');
  });
});
