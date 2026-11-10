import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { DemoBanner } from './DemoBanner.tsx';

afterEach(() => {
  cleanup();
  delete window.__APP_CONFIG__;
});

describe('DemoBanner', () => {
  it('shows when DEMO_MODE is true', () => {
    window.__APP_CONFIG__ = { DEMO_MODE: 'true' };
    render(<DemoBanner />);
    expect(screen.getByTestId('demo-banner').textContent).toContain('Demo mode');
  });

  it('is absent on a clean install', () => {
    window.__APP_CONFIG__ = { DEMO_MODE: 'false' };
    render(<DemoBanner />);
    expect(screen.queryByTestId('demo-banner')).toBeNull();
  });
});
