import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadNamespaces } from '../../../../lib/i18n.ts';
import { formatAnswer, VisitAnswers } from './VisitAnswers.tsx';

const mutate = vi.fn();
vi.mock('./api.ts', () => ({
  useVisitAnswers: () => ({
    data: {
      locationId: 'loc',
      fields: [
        {
          key: 'reason',
          label: 'Reason',
          help: null,
          type: 'single_choice',
          options: ['Cut'],
          required: true,
          staffOnly: false,
        },
        {
          key: 'allergy',
          label: 'Allergies',
          help: null,
          type: 'multi_choice',
          options: ['Latex', 'Nuts'],
          required: false,
          staffOnly: false,
        },
        {
          key: 'skipped',
          label: 'Skipped',
          help: null,
          type: 'short_text',
          options: [],
          required: false,
          staffOnly: false,
        },
        {
          key: 'triage',
          label: 'Triage',
          help: null,
          type: 'short_text',
          options: [],
          required: false,
          staffOnly: true,
        },
      ],
      answers: { reason: 'Cut', allergy: ['Latex', 'Nuts'], triage: 'Low' },
    },
  }),
  useSetVisitAnswers: () => ({ mutate, isPending: false, isError: false }),
}));

beforeAll(() => loadNamespaces('staff', 'guest-intake'));
afterEach(cleanup);

describe('VisitAnswers', () => {
  it("shows the guest's answers read-only and saves staff fields beside them unchanged", async () => {
    render(<VisitAnswers visit={{ id: 'v1', ticket: 'A001', notes: '', tags: [], version: 3 }} />);
    const list = within(screen.getByTestId('visit-answers'));
    expect(list.getByText('Reason')).toBeTruthy();
    expect(list.getByText('Latex, Nuts')).toBeTruthy();
    expect(list.queryByText('Skipped')).toBeNull();
    const triage = screen.getByLabelText(/Triage/);
    expect((triage as HTMLInputElement).value).toBe('Low');
    await userEvent.clear(triage);
    await userEvent.type(triage, 'High');
    await userEvent.click(screen.getByRole('button', { name: 'Save answers' }));
    expect(mutate.mock.calls[0]![0]).toEqual({
      reason: 'Cut',
      allergy: ['Latex', 'Nuts'],
      triage: 'High',
    });
  });

  it('formats every kind of stored answer', () => {
    expect(formatAnswer(true, 'Yes', 'No')).toBe('Yes');
    expect(formatAnswer(false, 'Yes', 'No')).toBe('No');
    expect(formatAnswer(4, 'Yes', 'No')).toBe('4');
    expect(formatAnswer({ name: 'Ann', guardian_name: 'Bo' }, 'Yes', 'No')).toBe('Ann (Bo)');
  });
});
