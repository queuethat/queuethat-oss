import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { RadioGroup, Segmented, Switch } from './Choice.tsx';

afterEach(cleanup);

const OPTIONS = [
  { value: 'a', label: 'Alpha', hint: 'First' },
  { value: 'b', label: 'Beta' },
  { value: 'c', label: 'Gamma', disabled: true },
];

function Controlled({ kind }: { kind: 'radio' | 'segmented' }) {
  const [v, setV] = useState('a');
  const C = kind === 'radio' ? RadioGroup : Segmented;
  return <C label="Pick one" options={OPTIONS} value={v} onChange={setV} error="Required" />;
}

describe('Switch', () => {
  it('is a labelled switch, described by hint and error, toggled by its label', async () => {
    render(<Switch label="Notify me" hint="By text" error="Needs a phone" />);
    const sw = screen.getByRole<HTMLInputElement>('switch', { name: 'Notify me' });
    expect(sw.getAttribute('aria-invalid')).toBe('true');
    const ids = (sw.getAttribute('aria-describedby') ?? '').split(' ');
    expect(ids.map((i) => document.getElementById(i)?.textContent)).toEqual([
      'By text',
      'Needs a phone',
    ]);
    await userEvent.click(screen.getByText('Notify me'));
    expect(sw.checked).toBe(true);
  });

  it('keeps a 48px hit target and a control border', () => {
    render(<Switch label="Notify me" />);
    const label = screen.getByText('Notify me').closest('label');
    expect(label?.className).toContain('min-h-target');
    expect(label?.querySelector('span')?.className).toContain('border-border-control');
  });
});

describe.each(['radio', 'segmented'] as const)('%s group', (kind) => {
  it('is a named group of radios and selects on click', async () => {
    render(<Controlled kind={kind} />);
    expect(screen.getByRole('group', { name: 'Pick one' })).toBeTruthy();
    const beta = screen.getByRole<HTMLInputElement>('radio', { name: /Beta/ });
    expect(screen.getByRole<HTMLInputElement>('radio', { name: /Alpha/ }).checked).toBe(true);
    await userEvent.click(beta);
    expect(beta.checked).toBe(true);
    expect(screen.getByText('Required')).toBeTruthy();
  });

  it('skips disabled options and moves with arrow keys', async () => {
    render(<Controlled kind={kind} />);
    expect(screen.getByRole<HTMLInputElement>('radio', { name: /Gamma/ }).disabled).toBe(true);
    screen.getByRole<HTMLInputElement>('radio', { name: /Alpha/ }).focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getByRole<HTMLInputElement>('radio', { name: /Beta/ }).checked).toBe(true);
  });
});
