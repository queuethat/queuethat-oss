import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadNamespaces } from '../../lib/i18n.ts';
import { ConsentOptIn } from './ConsentOptIn.tsx';

const business = { name: 'Demo Barber', contact: 'help@demo.test' };

function show() {
  return render(
    <ConsentOptIn business={business} locale="en" checked={false} onChange={() => {}} />,
  );
}

beforeAll(() => loadNamespaces('guest-join'));
afterEach(() => {
  cleanup();
  delete window.__APP_CONFIG__;
});

describe('ConsentOptIn legal links', () => {
  it('shows no legal line when nothing is configured', () => {
    show();
    expect(screen.getByTestId('sms-consent')).toBeDefined();
    expect(screen.queryByTestId('sms-legal')).toBeNull();
  });

  it("links to the install's own pages", () => {
    window.__APP_CONFIG__ = {
      TERMS_URL: 'https://shop.example/terms',
      PRIVACY_URL: 'https://shop.example/privacy',
    };
    show();
    const hrefs = screen.getAllByRole('link').map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(['https://shop.example/terms', 'https://shop.example/privacy']);
  });

  it('shows only the page that exists', () => {
    window.__APP_CONFIG__ = { TERMS_URL: '', PRIVACY_URL: 'https://shop.example/privacy' };
    show();
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute('href')).toBe('https://shop.example/privacy');
  });

  it('keeps the opt-in and drops the line when the install has published neither page', () => {
    window.__APP_CONFIG__ = { TERMS_URL: '', PRIVACY_URL: '' };
    show();
    expect(screen.getByTestId('sms-consent')).toBeDefined();
    expect(screen.queryByTestId('sms-legal')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });
});
