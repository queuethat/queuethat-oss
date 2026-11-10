import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import i18n, { loadNamespaces } from '../../lib/i18n.ts';
import { RetentionNotice } from './RetentionNotice.tsx';

beforeAll(() => loadNamespaces('guest-join'));
afterEach(async () => {
  cleanup();
  await i18n.changeLanguage('en');
});

describe('RetentionNotice', () => {
  it('names the business and the period, with a link to the privacy text', () => {
    render(<RetentionNotice business="Demo Barber" days={14} />);
    expect(screen.getByTestId('retention-notice').textContent).toContain(
      'Demo Barber keeps your visit details for 14 days.',
    );
    expect(screen.getByRole('link').getAttribute('href')).toBe('https://queuethat.com/privacy');
  });

  it('uses the singular for one day', () => {
    render(<RetentionNotice business="Demo Barber" days={1} />);
    expect(screen.getByTestId('retention-notice').textContent).toContain('for 1 day.');
  });

  it('reads in Spanish', async () => {
    await loadNamespaces('guest-join');
    await i18n.changeLanguage('es');
    render(<RetentionNotice business="Demo Barber" days={14} />);
    expect(screen.getByTestId('retention-notice').textContent).toContain(
      'Demo Barber conserva los datos de tu visita durante 14 días.',
    );
  });

  it('renders nothing before the period is known', () => {
    render(<RetentionNotice business="Demo Barber" days={null} />);
    expect(screen.queryByTestId('retention-notice')).toBeNull();
  });
});
