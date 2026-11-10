import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Select } from './Field.tsx';
import { PhoneInput } from './PhoneInput/PhoneInput.tsx';

afterEach(cleanup);

// #503: Safari on macOS draws a native select 23px tall whatever min-height says, unless the
// page takes over its appearance. Linux WebKit doesn't, so the browser suites can't catch it.
describe('selects', () => {
  it('Select takes over the native look and keeps the 48px minimum', () => {
    render(
      <Select label="Counter">
        <option>Chair 1</option>
      </Select>,
    );
    const select = screen.getByLabelText('Counter');
    expect(select.className).toMatch(/\bappearance-none\b/);
    expect(select.className).toMatch(/\bmin-h-target\b/);
    expect(select.parentElement!.querySelector('svg')!.getAttribute('aria-hidden')).toBe('true');
  });

  it('the PhoneInput country picker does too', () => {
    render(<PhoneInput label="Phone" countryLabel="Country" defaultCountry="US" />);
    const select = screen.getByLabelText('Country');
    expect(select.className).toMatch(/\bappearance-none\b/);
    expect(select.className).toMatch(/\bmin-h-target\b/);
  });
});
