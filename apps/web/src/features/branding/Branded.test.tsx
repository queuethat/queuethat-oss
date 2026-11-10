import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Branded } from './Branded.tsx';

afterEach(cleanup);
const rpc = vi.fn();
vi.mock('../guest/client.ts', () => ({ guestRpc: (...args: unknown[]) => rpc(...args) }));
vi.mock('../../lib/config.ts', () => ({ appConfig: () => ({ supabaseUrl: 'http://api.test' }) }));
vi.mock('../../lib/translation.tsx', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const row = {
  org_name: 'Barber & Co',
  logo_url: '/storage/v1/object/public/branding/org/o/branding/logo.webp',
  cover_url: null,
  brand_primary: '#0b3d91',
  brand_accent: null,
  welcome_text: '<script>alert(1)</script>',
  terms_url: 'https://example.com/terms',
  privacy_url: 'javascript:alert(1)',
  hide_product_branding: false,
};
const SOURCE = 'https://github.com/queuethat/queuethat-oss';

function renderBranded(slug: string | null = 'shop') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Branded slug={slug}>
        <p>page</p>
      </Branded>
    </QueryClientProvider>,
  );
}

describe('Branded', () => {
  it('AC1: shows welcome text as literal text, the logo, the colour and safe links only', async () => {
    rpc.mockResolvedValue(row);
    const { container } = renderBranded();
    expect(await screen.findByText('<script>alert(1)</script>')).toBeTruthy();
    expect(container.querySelector('script')).toBeNull();
    expect(screen.getByText('Barber & Co')).toBeTruthy();
    expect(await screen.findByText('branding.terms')).toBeTruthy();
    const logo = container.querySelector('img')!;
    expect(logo.getAttribute('src')).toBe(
      'http://api.test/storage/v1/object/public/branding/org/o/branding/logo.webp',
    );
    expect(logo.getAttribute('width')).toBe('40');
    const links = [...container.querySelectorAll('a')];
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['https://example.com/terms', SOURCE]);
    expect(links[0]!.getAttribute('rel')).toBe('noopener noreferrer');
    expect(document.documentElement.style.getPropertyValue('--color-primary')).toBe('#0b3d91');
    expect(document.documentElement.getAttribute('style')).toContain('--color-on-primary: #ffffff');
  });

  it('AC1 (4-WL1): the product name shows until the org hides it; the source link never goes', async () => {
    rpc.mockResolvedValue(row);
    renderBranded();
    expect(await screen.findByText('branding.poweredBy')).toBeTruthy();
    cleanup();
    rpc.mockResolvedValue({ ...row, hide_product_branding: true });
    const { container } = renderBranded();
    await screen.findByText('Barber & Co');
    await waitFor(() => expect(container.querySelector(`a[href="${SOURCE}"]`)).not.toBeNull());
    expect(screen.queryByText('branding.poweredBy')).toBeNull();
  });

  it('falls back to the default theme when the fetch fails or there is no slug', async () => {
    rpc.mockRejectedValue(new Error('not_found'));
    const { container } = renderBranded();
    expect(await screen.findByText('page')).toBeTruthy();
    expect(container.querySelector('header')).toBeNull();
    expect(screen.queryByTestId('branded')).toBeNull();
    await waitFor(() => expect(container.querySelector(`a[href="${SOURCE}"]`)).not.toBeNull());
    expect(screen.queryByText('branding.poweredBy')).toBeNull();
    cleanup();
    rpc.mockClear();
    const noSlug = renderBranded(null);
    expect(rpc).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(noSlug.container.querySelector(`a[href="${SOURCE}"]`)).not.toBeNull(),
    );
  });
});
