import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { Checkbox } from './Field.tsx';

afterEach(cleanup);

describe('Checkbox', () => {
  it('is named by its label, described by its hint, and toggles from the label', async () => {
    render(<Checkbox label="Show names" hint="Off by default" />);
    const box = screen.getByRole<HTMLInputElement>('checkbox', { name: 'Show names' });
    const hint = document.getElementById(box.getAttribute('aria-describedby') ?? '');
    expect(hint?.textContent).toBe('Off by default');
    await userEvent.click(screen.getByText('Show names'));
    expect(box.checked).toBe(true);
  });
});
