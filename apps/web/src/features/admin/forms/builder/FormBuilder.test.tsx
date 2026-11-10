import { ToastProvider } from '@qm/ui';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadNamespaces } from '../../../../lib/i18n.ts';
import { FormBuilder } from './FormBuilder.tsx';
import type { BuilderField } from './fields.ts';

beforeAll(() => loadNamespaces('admin-form-builder'));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

let current: BuilderField[] = [];

function Harness({ initial, healthTagged }: { initial: BuilderField[]; healthTagged?: boolean }) {
  const [fields, setFields] = useState(initial);
  useEffect(() => {
    current = fields;
  });
  return (
    <ToastProvider regionLabel="Notifications" dismissLabel="Dismiss" undoLabel="Undo">
      <FormBuilder fields={fields} onChange={setFields} healthTagged={healthTagged} />
    </ToastProvider>
  );
}
const field = (key: string, label: string): BuilderField => ({ key, label, type: 'short_text' });

describe('FormBuilder', () => {
  it('adds a library type by tap and opens it for editing', () => {
    render(<Harness initial={[]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add Single choice' }));
    expect(current).toHaveLength(1);
    expect(current[0]).toMatchObject({ key: 'single_choice_1', options: ['Option 1', 'Option 2'] });
    expect(screen.getByRole('textbox', { name: 'Choices' })).toBeTruthy();
  });

  it('edits a label without changing its key', () => {
    render(<Harness initial={[field('short_text_1', 'Name')]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit Name' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Question' }), {
      target: { value: 'Full name' },
    });
    expect(current[0]).toMatchObject({ key: 'short_text_1', label: 'Full name' });
  });

  it('reorders with the move buttons', () => {
    render(<Harness initial={[field('a', 'First'), field('b', 'Second')]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Move First down' }));
    expect(current.map((f) => f.key)).toEqual(['b', 'a']);
  });

  it('offers no drag handles at phone width and still reorders by button', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: true,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    render(<Harness initial={[field('a', 'First'), field('b', 'Second')]} />);
    expect(screen.queryByRole('button', { name: /^Reorder / })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Move First down' }));
    expect(current.map((f) => f.key)).toEqual(['b', 'a']);
  });

  it('keeps drag handles at tablet and desktop width', () => {
    render(<Harness initial={[field('a', 'First')]} />);
    expect(screen.getByRole('button', { name: 'Reorder First' })).toBeTruthy();
  });

  it('removes a field and undo puts it back in place', () => {
    render(<Harness initial={[field('a', 'First'), field('b', 'Second'), field('c', 'Third')]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove Second' }));
    expect(current.map((f) => f.key)).toEqual(['a', 'c']);
    fireEvent.click(
      within(screen.getByRole('region', { name: 'Notifications' })).getByText('Undo'),
    );
    expect(current.map((f) => f.key)).toEqual(['a', 'b', 'c']);
  });

  it('shows the sensitive warnings, plus the health-tagged one', () => {
    const sensitive: BuilderField = { ...field('a', 'Reason'), sensitivity: 'sensitive' };
    render(<Harness initial={[sensitive]} healthTagged />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit Reason' }));
    expect(screen.getByText(/needs a recorded privacy contact/)).toBeTruthy();
    expect(screen.getByText(/health-tagged/)).toBeTruthy();
  });

  it('hides required and sensitivity for a heading', () => {
    render(<Harness initial={[{ key: 'h', label: 'Note', type: 'heading' }]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit Note' }));
    expect(screen.queryByRole('checkbox', { name: 'Guests must answer' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: /sensitive is the answer/i })).toBeNull();
  });

  it('stops offering types at 20 fields', () => {
    const many = Array.from({ length: 20 }, (_, i) => field(`f${i}`, `Q${i}`));
    render(<Harness initial={many} />);
    expect(
      (screen.getByRole('button', { name: 'Add Short text' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
