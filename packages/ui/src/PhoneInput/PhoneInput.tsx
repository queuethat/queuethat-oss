import {
  getCountries,
  getCountryCallingCode,
  isSupportedCountry,
  parsePhoneNumberFromString,
  type CountryCode,
} from 'libphonenumber-js/min';
import { useLayoutEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { control, FieldShell, SelectControl, useField } from '../Field.tsx';
import { cx } from '../cx.ts';
import { applyEdit, strip } from './format.ts';

export type { CountryCode };

export interface PhoneInputProps {
  /** Visible label for the number; pass through t(). */
  label: string;
  /** Accessible name of the country picker; pass through t(). */
  countryLabel: string;
  /** The location's country. A number typed with a leading '+' overrides it. */
  defaultCountry: CountryCode;
  /** E.164, e.g. "+14155550123". */
  defaultValue?: string;
  /** Called with E.164 when the number is valid for its country, otherwise null. */
  onChange?: (e164: string | null) => void;
  /**
   * Called when the field moves between empty, a valid number and digits that aren't one yet,
   * so a form can refuse to submit a number it would otherwise drop as null.
   */
  onStateChange?: (state: PhoneState) => void;
  /** Submits the E.164 value (or an empty string) under this name in a plain form. */
  name?: string;
  hint?: string;
  error?: string;
  required?: boolean;
  disabled?: boolean;
  /** BCP 47 locale for country names; defaults to the browser's. */
  locale?: string;
}

/** Every country a phone number can belong to, with its dialling code, sorted by `locale` name. */
export function phoneCountries(locale?: string) {
  const names = new Intl.DisplayNames(locale ? [locale] : undefined, { type: 'region' });
  return getCountries()
    .map((code) => ({ code, name: names.of(code) ?? code, dial: getCountryCallingCode(code) }))
    .sort((a, b) => a.name.localeCompare(b.name, locale));
}

export function toE164(text: string, country: CountryCode): string | null {
  const parsed = parsePhoneNumberFromString(text, country);
  return parsed?.isValid() ? parsed.number : null;
}

function initialText(value: string | undefined, country: CountryCode): string {
  const parsed = value ? parsePhoneNumberFromString(value) : undefined;
  if (!parsed) return '';
  return parsed.country === country ? parsed.formatNational() : parsed.formatInternational();
}

/** What the field holds: nothing, a valid number, or digits that aren't a number yet. */
export type PhoneState = 'empty' | 'valid' | 'invalid';

function stateOf(text: string, e164: string | null): PhoneState {
  if (e164) return 'valid';
  return strip(text).replace('+', '') ? 'invalid' : 'empty';
}

/**
 * Country-aware phone field (J-17). Formats as you type, keeps the caret where it was across
 * re-formatting, and reports E.164 or null. Contact is optional, so empty is valid input.
 * Imported from `@qm/ui/phone`, not the main entry: the number metadata is ~40 KB, and guest
 * pages load it only when the field is shown.
 */
export function PhoneInput({
  label,
  countryLabel,
  defaultCountry,
  defaultValue,
  onChange,
  onStateChange,
  name,
  hint,
  error,
  required,
  disabled,
  locale,
}: PhoneInputProps) {
  const field = useField({ hint, error });
  const [country, setCountry] = useState<CountryCode>(
    () =>
      (defaultValue && parsePhoneNumberFromString(defaultValue)?.country) ||
      // A guessed default (e.g. from the browser locale) may name a region with no metadata.
      (isSupportedCountry(defaultCountry) ? defaultCountry : 'US'),
  );
  const [text, setText] = useState(() => initialText(defaultValue, country));
  const inputRef = useRef<HTMLInputElement>(null);
  const pendingCaret = useRef<number | null>(null);
  const e164 = toE164(text, country);

  const countries = useMemo(() => phoneCountries(locale), [locale]);

  useLayoutEffect(() => {
    const caret = pendingCaret.current;
    if (caret === null || !inputRef.current) return;
    inputRef.current.setSelectionRange(caret, caret);
    pendingCaret.current = null;
  });

  function commit(nextText: string, nextCountry: CountryCode) {
    const before = toE164(text, country);
    const after = toE164(nextText, nextCountry);
    setText(nextText);
    setCountry(nextCountry);
    if (after !== before) onChange?.(after);
    const state = stateOf(nextText, after);
    if (state !== stateOf(text, before)) onStateChange?.(state);
  }

  function handleInput(event: ChangeEvent<HTMLInputElement>) {
    const input = event.target;
    const inputType = (event.nativeEvent as InputEvent).inputType;
    const edit = applyEdit(
      text,
      input.value,
      input.selectionStart ?? input.value.length,
      country,
      inputType,
    );
    pendingCaret.current = edit.caret;
    // An international number names its own country; keep the picker in step with it.
    commit(edit.text, edit.text.startsWith('+') && edit.country ? edit.country : country);
  }

  function handleCountry(event: ChangeEvent<HTMLSelectElement>) {
    const next = event.target.value as CountryCode;
    commit(applyEdit(text, text, text.length, next).text, next);
  }

  return (
    <FieldShell
      {...{ id: field.id, label, hint, hintId: field.hintId, error, errorId: field.errorId }}
    >
      <div className="flex gap-2">
        <SelectControl
          aria-label={countryLabel}
          value={country}
          disabled={disabled}
          onChange={handleCountry}
          wrapperClassName="w-32 max-w-[40%] shrink-0"
        >
          {countries.map((c) => (
            <option key={c.code} value={c.code}>
              {`+${c.dial} ${c.name}`}
            </option>
          ))}
        </SelectControl>
        <input
          ref={inputRef}
          id={field.id}
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          value={text}
          onChange={handleInput}
          required={required}
          disabled={disabled}
          aria-describedby={field.describedBy}
          aria-invalid={error ? true : undefined}
          className={cx(control, 'min-w-0 flex-1')}
        />
      </div>
      {name ? <input type="hidden" name={name} value={e164 ?? ''} /> : null}
    </FieldShell>
  );
}
