import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadNamespaces } from '../../../../../lib/i18n.ts';
import type { BuilderField } from '../fields.ts';
import { Preview } from './Preview.tsx';

beforeAll(() => loadNamespaces('admin-form-builder', 'guest-intake'));
afterEach(cleanup);

const f = (key: string, label: string, extra: Partial<BuilderField> = {}): BuilderField => ({
  key,
  label,
  type: 'short_text',
  ...extra,
});

describe('Preview', () => {
  it('renders guest questions with the guest component, leaves out staff-only ones, and takes input', () => {
    render(
      <Preview
        fields={[
          f('a', 'Party name', { required: true }),
          f('b', 'Internal note', { visibility: 'staff_only' }),
        ]}
        purposeText="So we can greet you"
        retentionDays={30}
      />,
    );
    const input = screen.getByRole('textbox', { name: /Party name/ });
    fireEvent.change(input, { target: { value: 'Sam' } });
    expect((input as HTMLInputElement).value).toBe('Sam');
    expect(screen.queryByText(/Internal note/)).toBeNull();
    expect(screen.getByText('So we can greet you')).toBeTruthy();
    expect(screen.getByTestId('fill-estimate').textContent).toBe('About 10 seconds to fill in.');
    expect(screen.getByTestId('preview-retention').textContent).toBe(
      'Answers are kept for 30 days, then deleted.',
    );
  });

  it('says so when there is nothing to show and hides retention until it is valid', () => {
    render(<Preview fields={[]} purposeText="" retentionDays={null} />);
    expect(screen.getByText('Guests have nothing to fill in.')).toBeTruthy();
    expect(screen.queryByTestId('preview-retention')).toBeNull();
  });

  it('switches to minutes for long forms', () => {
    const many = Array.from({ length: 6 }, (_, i) => f(`q${i}`, `Q${i}`, { type: 'long_text' }));
    render(<Preview fields={many} purposeText="" retentionDays={365} />);
    expect(screen.getByTestId('fill-estimate').textContent).toBe('About 2 minutes to fill in.');
  });
});
