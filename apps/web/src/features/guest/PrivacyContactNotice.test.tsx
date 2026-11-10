import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadNamespaces } from '../../lib/i18n.ts';
import { PrivacyContactNotice, parsePrivacyContact } from './PrivacyContactNotice.tsx';

beforeAll(() => loadNamespaces('guest-join'));
afterEach(cleanup);

describe('PrivacyContactNotice', () => {
  it('shows the officer name and a mailto link', () => {
    render(<PrivacyContactNotice contact={{ name: 'Dana', email: 'dana@example.test' }} />);
    expect(screen.getByTestId('privacy-contact-notice').textContent).toContain('Dana');
    expect(screen.getByRole('link', { name: 'dana@example.test' }).getAttribute('href')).toBe(
      'mailto:dana@example.test',
    );
    expect(screen.queryByRole('link', { name: /\d/ })).toBeNull();
  });

  it('shows the phone only when the database sent one', () => {
    render(
      <PrivacyContactNotice contact={{ name: 'D', email: 'd@e.test', phone: '+1 204 555 0100' }} />,
    );
    expect(screen.getByRole('link', { name: '+1 204 555 0100' }).getAttribute('href')).toBe(
      'tel:+12045550100',
    );
  });

  it('cannot smuggle mailto parameters through the address', () => {
    render(<PrivacyContactNotice contact={{ name: 'D', email: 'a@b.test?bcc=x@y.test' }} />);
    const href = screen.getByRole('link', { name: /a@b.test/ }).getAttribute('href') ?? '';
    expect(href.startsWith('mailto:a@b.test%3F')).toBe(true);
    expect(href).not.toContain('?');
  });

  it('renders nothing without a contact', () => {
    render(<PrivacyContactNotice contact={null} />);
    expect(screen.queryByTestId('privacy-contact-notice')).toBeNull();
  });

  it('parses only a complete contact', () => {
    expect(parsePrivacyContact(null)).toBeNull();
    expect(parsePrivacyContact({ name: 'A' })).toBeNull();
    expect(parsePrivacyContact({ name: 'A', email: 'a@b.test', phone: 5 })).toEqual({
      name: 'A',
      email: 'a@b.test',
      phone: undefined,
    });
  });
});
