import { ToastProvider } from '@qm/ui';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadNamespaces } from '../../../../lib/i18n.ts';
import { fieldsPayload, fromStored } from '../fields.ts';
import { FormBuilder } from './FormBuilder.tsx';
import { fieldProblems, newField, patchField, type BuilderField } from './fields.ts';
import { fillSeconds } from './preview/estimate.ts';

beforeAll(() => loadNamespaces('admin-form-builder'));
afterEach(cleanup);

let current: BuilderField[] = [];
function Harness({ initial }: { initial: BuilderField[] }) {
  const [fields, setFields] = useState(initial);
  useEffect(() => {
    current = fields;
  });
  return (
    <ToastProvider regionLabel="Notifications" dismissLabel="Dismiss" undoLabel="Undo">
      <FormBuilder fields={fields} onChange={setFields} />
    </ToastProvider>
  );
}

describe('agreement and signature in the builder', () => {
  it('adds an agreement and edits its text and requiredness', () => {
    render(<Harness initial={[]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add Agreement' }));
    expect(current[0]).toMatchObject({ key: 'agreement_1', type: 'agreement', body: '' });
    fireEvent.change(screen.getByRole('textbox', { name: 'Agreement text' }), {
      target: { value: 'I accept the risks.' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Guests must answer' }));
    expect(current[0]).toMatchObject({ body: 'I accept the risks.', required: true });
    expect(screen.queryByRole('combobox', { name: 'Who sees this question' })).toBeNull();
  });

  it('offers the guardian toggle on a signature only', () => {
    render(<Harness initial={[]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add Typed signature' }));
    fireEvent.click(screen.getByRole('checkbox', { name: /parent or guardian/ }));
    expect(current[0]).toMatchObject({ type: 'signature', collect_guardian: true });
    fireEvent.click(screen.getByRole('checkbox', { name: /parent or guardian/ }));
    expect(current[0]).not.toHaveProperty('collect_guardian');
  });

  it('asks for text and refuses angle brackets before the database does', () => {
    const a = newField('agreement', [], 'Waiver', []);
    expect(fieldProblems(a)).toContain('body');
    expect(fieldProblems(patchField(a, { body: 'a <b>' }))).toContain('markup');
    expect(fieldProblems(patchField(a, { body: 'Fine **text**' }))).toEqual([]);
  });

  it('keeps both types when a stored version is opened and saved again', () => {
    const stored = [
      { key: 'a', label: 'Waiver', type: 'agreement', body: 'Text', required: true },
      { key: 's', label: 'Sign', type: 'signature', collect_guardian: true, required: true },
    ];
    expect(fieldsPayload(fromStored(stored))).toEqual(stored);
  });

  it('counts reading time for an agreement', () => {
    expect(fillSeconds([newField('agreement', [], 'W', [])])).toBe(30);
  });
});
