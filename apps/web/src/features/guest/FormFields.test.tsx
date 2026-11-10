import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import i18n, { loadNamespaces } from '../../lib/i18n.ts';
import { FormFields } from './FormFields.tsx';
import type { FormField } from './formFields.ts';

beforeAll(() => loadNamespaces('guest-intake'));
afterEach(async () => {
  cleanup();
  await i18n.changeLanguage('en');
});

const fields: FormField[] = [
  { key: 'h', label: 'About you', help: null, type: 'heading', options: [], required: false },
  { key: 'why', label: 'Reason', help: 'Briefly', type: 'long_text', options: [], required: true },
  {
    key: 'size',
    label: 'Size',
    help: null,
    type: 'single_choice',
    options: ['S', 'L'],
    required: false,
  },
  {
    key: 'areas',
    label: 'Areas',
    help: null,
    type: 'multi_choice',
    options: ['Back', 'Neck'],
    required: false,
  },
  { key: 'first', label: 'First visit', help: null, type: 'yes_no', options: [], required: false },
  { key: 'when', label: 'Birthday', help: null, type: 'date', options: [], required: false },
];

describe('FormFields', () => {
  it('draws every field type in published order, marking required and optional', () => {
    render(<FormFields fields={fields} draft={{}} errors={{}} onChange={() => undefined} />);
    expect(screen.getByRole('heading', { name: 'About you' })).toBeTruthy();
    expect(screen.getByLabelText('Reason (required)')).toBeTruthy();
    expect(screen.getByLabelText('Size (optional)')).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Areas (optional)' })).toBeTruthy();
    expect(screen.getByLabelText('Neck')).toBeTruthy();
    expect(screen.getByLabelText('First visit (optional)')).toBeTruthy();
    expect(screen.getByLabelText('Birthday (optional)').getAttribute('type')).toBe('date');
  });

  it('reports typed text, ticked options and a ticked box by key', async () => {
    const onChange = vi.fn();
    render(
      <FormFields fields={fields} draft={{ areas: ['Back'] }} errors={{}} onChange={onChange} />,
    );
    await userEvent.type(screen.getByLabelText('Reason (required)'), 'x');
    expect(onChange).toHaveBeenLastCalledWith('why', 'x');
    await userEvent.click(screen.getByLabelText('Neck'));
    expect(onChange).toHaveBeenLastCalledWith('areas', ['Back', 'Neck']);
    await userEvent.click(screen.getByLabelText('Back'));
    expect(onChange).toHaveBeenLastCalledWith('areas', []);
    await userEvent.click(screen.getByLabelText('First visit (optional)'));
    expect(onChange).toHaveBeenLastCalledWith('first', true);
  });

  it('shows the database refusal under the field it names and links it for screen readers', () => {
    render(
      <FormFields
        fields={fields}
        draft={{}}
        errors={{ why: 'Please check this answer.' }}
        onChange={() => undefined}
      />,
    );
    const box = screen.getByLabelText('Reason (required)');
    expect(box.getAttribute('aria-invalid')).toBe('true');
    expect(box.getAttribute('aria-describedby')).toBeTruthy();
    expect(screen.getByText('Please check this answer.')).toBeTruthy();
  });

  it('reads in Spanish', async () => {
    await loadNamespaces('guest-intake');
    await i18n.changeLanguage('es');
    render(<FormFields fields={fields} draft={{}} errors={{}} onChange={() => undefined} />);
    expect(screen.getByRole('group', { name: 'Unas preguntas' })).toBeTruthy();
    expect(screen.getByLabelText('Reason (obligatorio)')).toBeTruthy();
  });

  it('draws an unticked agreement with its formatted text and reports acceptance', async () => {
    const onChange = vi.fn();
    const waiver: FormField[] = [
      {
        key: 'w',
        label: 'Waiver',
        help: null,
        type: 'agreement',
        options: [],
        required: true,
        body: 'Read this.\n\n- **No** running',
      },
    ];
    render(<FormFields fields={waiver} draft={{}} errors={{}} onChange={onChange} />);
    expect(screen.getByRole('heading', { name: 'Waiver' })).toBeTruthy();
    expect(screen.getByText('No').tagName).toBe('STRONG');
    const box = screen.getByLabelText('I have read and agree (required)') as HTMLInputElement;
    expect(box.checked).toBe(false);
    await userEvent.click(box);
    expect(onChange).toHaveBeenCalledWith('w', true);
    expect(document.body.textContent).not.toMatch(/legally binding/i);
  });

  it('asks for a guardian name only when the business does', async () => {
    const onChange = vi.fn();
    const sign = (collectGuardian: boolean): FormField[] => [
      {
        key: 's',
        label: 'Your name',
        help: null,
        type: 'signature',
        options: [],
        required: true,
        collectGuardian,
      },
    ];
    const { rerender } = render(
      <FormFields fields={sign(false)} draft={{}} errors={{}} onChange={onChange} />,
    );
    expect(screen.queryByLabelText('Parent or guardian name')).toBeNull();
    rerender(<FormFields fields={sign(true)} draft={{}} errors={{}} onChange={onChange} />);
    await userEvent.type(screen.getByLabelText('Parent or guardian name'), 'L');
    expect(onChange).toHaveBeenCalledWith('s.guardian', 'L');
  });

  it('shows the Spanish accept label', async () => {
    await i18n.changeLanguage('es');
    const waiver: FormField[] = [
      {
        key: 'w',
        label: 'W',
        help: null,
        type: 'agreement',
        options: [],
        required: false,
        body: 'x',
      },
    ];
    render(<FormFields fields={waiver} draft={{}} errors={{}} onChange={() => undefined} />);
    expect(screen.getByLabelText(/He leído y acepto/)).toBeTruthy();
  });
});
