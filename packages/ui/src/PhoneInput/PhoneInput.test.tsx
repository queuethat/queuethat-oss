import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { strip } from './format.ts';
import { PhoneInput, type PhoneInputProps } from './PhoneInput.tsx';

afterEach(cleanup);

function setup(props: Partial<PhoneInputProps> = {}) {
  const onChange = vi.fn();
  render(
    <form aria-label="join">
      <PhoneInput
        label="Phone"
        countryLabel="Country"
        defaultCountry="US"
        onChange={onChange}
        name="phone"
        {...props}
      />
    </form>,
  );
  const input = screen.getByLabelText<HTMLInputElement>('Phone');
  return { user: userEvent.setup(), input, onChange };
}

describe('PhoneInput', () => {
  it('replaces one middle digit without moving the caret or touching the rest (AC1)', async () => {
    const { user, input } = setup();
    await user.type(input, '+1 415 555 0123');
    expect(input.value).toBe('+1 415 555 0123');

    // Caret after the second 5 of "555": delete it, type a 7.
    await user.type(input, '{Backspace}', { initialSelectionStart: 9, initialSelectionEnd: 9 });
    expect(input.selectionStart).toBe(8);
    await user.keyboard('7');

    expect(input.value).toBe('+1 415 575 0123');
    expect(input.selectionStart).toBe(9);
  });

  it('formats national numbers for the default country as you type', async () => {
    const { user, input } = setup();
    await user.type(input, '4155550123');
    expect(input.value).toBe('(415) 555-0123');
  });

  it('edits a digit in a formatted national number in place', async () => {
    const { user, input } = setup({ defaultValue: '+14155550123' });
    expect(input.value).toBe('(415) 555-0123');
    // Caret after "(415) 5": backspace removes that 5, then 9 goes back in the same slot.
    await user.type(input, '{Backspace}9', { initialSelectionStart: 7, initialSelectionEnd: 7 });
    expect(input.value).toBe('(415) 955-0123');
    expect(input.selectionStart).toBe(7);
  });

  it('deletes the digit before a space instead of the space alone', async () => {
    const { user, input } = setup({ defaultValue: '+14155550123' });
    // Caret right after "(415) ": Backspace would only hit the space, which formatting restores.
    await user.type(input, '{Backspace}', { initialSelectionStart: 6, initialSelectionEnd: 6 });
    expect(input.value.replace(/\D/g, '')).toBe('415550123');
    expect(input.value.slice(0, input.selectionStart ?? 0).replace(/\D/g, '')).toBe('41');
  });

  it('forward Delete removes the digit after the caret and leaves the caret before the next one', async () => {
    const { user, input } = setup();
    await user.type(input, '+1 415 575 0123');
    // Caret before the 4 (browser pass 2): Delete used to leave the caret before the space.
    await user.type(input, '{Delete}', { initialSelectionStart: 3, initialSelectionEnd: 3 });
    expect(strip(input.value)).toBe('+1155750123');
    const caret = input.selectionStart ?? 0;
    expect(strip(input.value.slice(0, caret))).toBe('+1');
    expect(input.value[caret]).toBe('1');
  });

  it('forward Delete on a space removes the digit after it', async () => {
    const { user, input } = setup({ defaultValue: '+14155550123' });
    // Caret right before the space in "(415) ": Delete would only hit the space.
    await user.type(input, '{Delete}', { initialSelectionStart: 5, initialSelectionEnd: 5 });
    expect(input.value.replace(/\D/g, '')).toBe('415550123');
    expect(input.value.slice(0, input.selectionStart ?? 0).replace(/\D/g, '')).toBe('415');
  });

  it('emits E.164 when valid and null when not', async () => {
    const { user, input, onChange } = setup();
    await user.type(input, '415555012');
    expect(onChange).not.toHaveBeenCalled();
    await user.type(input, '3');
    expect(onChange).toHaveBeenLastCalledWith('+14155550123');
    await user.type(input, '{Backspace}');
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it('submits E.164 in the named hidden field', async () => {
    const { user, input } = setup();
    await user.type(input, '4155550123');
    const form = screen.getByRole('form', { name: 'join' }) as HTMLFormElement;
    expect(new FormData(form).get('phone')).toBe('+14155550123');
  });

  it('follows the country of an international number and re-formats on country change', async () => {
    const { user, input } = setup();
    await user.type(input, '+44 20 7946 0958');
    const country = screen.getByLabelText<HTMLSelectElement>('Country');
    expect(country.value).toBe('GB');

    await user.clear(input);
    await user.selectOptions(country, 'GB');
    await user.type(input, '02079460958');
    expect(input.value).toBe('020 7946 0958');
  });

  it('uses autocomplete=tel and a phone keypad', () => {
    const { input } = setup();
    expect(input.getAttribute('autocomplete')).toBe('tel');
    expect(input.getAttribute('type')).toBe('tel');
    expect(input.getAttribute('inputmode')).toBe('tel');
  });
});

describe('PhoneInput defaults', () => {
  it('falls back to US when the default country has no metadata', () => {
    setup({ defaultCountry: 'ZZ' as PhoneInputProps['defaultCountry'] });
    expect(screen.getByLabelText<HTMLSelectElement>('Country').value).toBe('US');
  });

  it('reports empty, invalid and valid as the number is typed and cleared', async () => {
    const onStateChange = vi.fn();
    const { user, input } = setup({ onStateChange });
    await user.type(input, '123');
    expect(onStateChange.mock.calls).toEqual([['invalid']]);
    await user.clear(input);
    await user.type(input, '+1 415 555 0123');
    expect(onStateChange.mock.calls.map(([state]) => state)).toEqual([
      'invalid',
      'empty',
      'invalid',
      'valid',
    ]);
  });
});
