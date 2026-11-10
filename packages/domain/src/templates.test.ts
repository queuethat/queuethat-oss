import { describe, expect, it } from 'vitest';
import {
  renderTemplate,
  SAMPLE_TEMPLATE_VARS,
  TEMPLATE_VARIABLES,
  templateParams,
} from './templates.ts';

describe('templateParams', () => {
  it('lists placeholders in order with values or fallbacks, never empty', () => {
    expect(
      templateParams('Hi {{guest_first_name}}, {ticket} at {{counter}} ({{unknown_thing}})', {
        ticket: 'A001',
      }),
    ).toEqual(['there', 'A001', 'the counter', '-']);
  });
  it('makes values acceptable to Meta: one line, single spaces, bounded', () => {
    const [name, long] = templateParams('{{guest_first_name}} {{ticket}}', {
      guest_first_name: 'Ann\n   Lee\t x',
      ticket: 'x'.repeat(2000),
    });
    expect(name).toBe('Ann Lee x');
    expect(long).toHaveLength(1000);
  });
  it('repeats a variable each time it appears, as Meta numbers positions', () => {
    expect(templateParams('{{ticket}} / {{ticket}}', { ticket: 'B2' })).toEqual(['B2', 'B2']);
  });
});

describe('renderTemplate', () => {
  it('fills {{double}} and legacy {single} placeholders', () => {
    expect(renderTemplate('{{ticket}} at {counter}', { ticket: 'B7', counter: 3 })).toBe('B7 at 3');
  });

  it('allows spaces inside the braces', () => {
    expect(renderTemplate('Hi {{ guest_first_name }}', { guest_first_name: 'Ana' })).toBe('Hi Ana');
  });

  it('renders a fallback for a missing variable and leaves no {{', () => {
    const out = renderTemplate('Hi {{guest_first_name}}, go to {{counter}}.', {});
    expect(out).toBe('Hi there, go to the counter.');
    expect(out).not.toContain('{{');
  });

  it('treats an empty or null value as missing', () => {
    expect(renderTemplate('{{counter}}', { counter: '' })).toBe('the counter');
    expect(renderTemplate('{{counter}}', { counter: null })).toBe('the counter');
  });

  it('renders nothing for a variable with no fallback', () => {
    expect(renderTemplate('{ticket} at {counter}{x}', { ticket: 'B7', counter: 3 })).toBe(
      'B7 at 3',
    );
    expect(renderTemplate('{{ticket}} {{nope}}!', { ticket: 'A1' })).toBe('A1 !');
  });

  it('drops an optional [segment] whose variable has no value', () => {
    const called = "It's your turn: {{ticket}}.[ Please go to {{counter}}.]";
    expect(renderTemplate(called, { ticket: 'A1', counter: 'Chair 2' })).toBe(
      "It's your turn: A1. Please go to Chair 2.",
    );
    expect(renderTemplate(called, { ticket: 'A1' })).toBe("It's your turn: A1.");
    expect(renderTemplate('Keep [this] text', {})).toBe('Keep [this] text');
  });

  it('keeps a segment written with a space before the bracket', () => {
    expect(renderTemplate('Go [to {counter}]', { counter: 'A' })).toBe('Go to A');
    expect(renderTemplate('Go [to {counter}]', {})).toBe('Go');
  });

  it('does not interpret HTML or expand substituted values again', () => {
    expect(
      renderTemplate('<b>{{ticket}}</b> {{guest_first_name}}', {
        ticket: 'A1',
        guest_first_name: '{{ticket}}',
      }),
    ).toBe('<b>A1</b> {{ticket}}');
  });

  it('uses English fallbacks for an unknown locale', () => {
    expect(renderTemplate('{{counter}}', {}, 'xx')).toBe('the counter');
  });
});

describe('editor preview data', () => {
  it('has a sample value for every variable a template may use', () => {
    for (const names of Object.values(TEMPLATE_VARIABLES)) {
      for (const name of names) expect(SAMPLE_TEMPLATE_VARS[name], name).toBeTruthy();
    }
  });
});

describe('the default joined text (#1139)', () => {
  const joined =
    "You're in line at {{location_name}}: ticket {{ticket}}, number {{position}}. [Follow your place: {status_link}]";

  it('names the business and drops the link sentence when there is no link', () => {
    expect(
      renderTemplate(joined, { location_name: 'Joe Barber', ticket: 'A042', position: 3 }),
    ).toBe("You're in line at Joe Barber: ticket A042, number 3.");
  });

  it('keeps the link sentence when a link is given', () => {
    expect(
      renderTemplate(joined, {
        location_name: 'Joe Barber',
        ticket: 'A042',
        position: 3,
        status_link: 'https://app.queuethat.com/v/x',
      }),
    ).toBe(
      "You're in line at Joe Barber: ticket A042, number 3. Follow your place: https://app.queuethat.com/v/x",
    );
  });
});
