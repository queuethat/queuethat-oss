import { ToastProvider } from '@qm/ui';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadNamespaces } from '../../../../lib/i18n.ts';
import { FormEditor } from '../FormEditor.tsx';
import { starterForm } from '../waivers/starters.ts';

beforeAll(() => loadNamespaces('admin-forms', 'admin-form-builder', 'guest-intake'));
afterEach(cleanup);

const BANNER = 'A starting point, not legal advice. Have your own counsel review before using.';
const noop = () => {};
const editor = (props: Partial<Parameters<typeof FormEditor>[0]>) =>
  render(
    <ToastProvider regionLabel="Notifications" dismissLabel="Dismiss" undoLabel="Undo">
      <FormEditor
        form={null}
        healthTagged={false}
        pending={false}
        onCancel={noop}
        onSave={noop}
        {...props}
      />
    </ToastProvider>,
  );

describe('WaiverBanner in the form editor', () => {
  it('opens a sample waiver prefilled, with the banner and the retention note', () => {
    editor({ starter: starterForm('tattoo', 'en') });
    expect(screen.getByDisplayValue('Tattoo and piercing consent')).toBeTruthy();
    expect(screen.getByDisplayValue(/know the risks/)).toBeTruthy();
    const note = screen.getByRole('note');
    expect(note.textContent).toContain(BANNER);
    expect(note.textContent).toContain('365 days');
  });

  it('is absent on a plain form with no agreement', () => {
    editor({});
    expect(screen.queryByRole('note')).toBeNull();
  });
});
