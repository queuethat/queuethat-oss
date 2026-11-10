import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import i18n from './i18n.ts';
import { Trans, useTranslation } from './translation.tsx';

afterEach(cleanup);

function Title() {
  const { t } = useTranslation('guest');
  return <h1>{t('status.title')}</h1>;
}

describe('translation', () => {
  it('re-renders when strings for the active language arrive', async () => {
    i18n.addResourceBundle('en', 'guest', { status: { title: 'Before' } }, true, true);
    render(<Title />);
    expect(screen.getByRole('heading').textContent).toBe('Before');
    await act(async () => {
      i18n.addResourceBundle('en', 'guest', { status: { title: 'After' } }, true, true);
    });
    expect(screen.getByRole('heading').textContent).toBe('After');
  });

  it('splices elements into <tag> markers, nested and unknown ones included', () => {
    const t = (() => 'Agree to <a>terms and <b>privacy</b></a> and <x>more</x>.') as never;
    render(
      <p data-testid="p">
        <Trans t={t} i18nKey={'k' as never} components={{ a: <a href="/t">link</a>, b: <b /> }} />
      </p>,
    );
    expect(screen.getByRole('link').getAttribute('href')).toBe('/t');
    expect(screen.getByText('privacy').tagName).toBe('B');
    expect(screen.getByTestId('p').textContent).toBe('Agree to terms and privacy and more.');
  });
});

describe('useTranslation identity', () => {
  it('keeps the same t between renders until strings change', async () => {
    const seen: unknown[] = [];
    function Probe() {
      seen.push(useTranslation('guest').t);
      return null;
    }
    const { rerender } = render(<Probe />);
    rerender(<Probe />);
    expect(seen[1]).toBe(seen[0]);
    await act(async () => {
      i18n.addResourceBundle('en', 'guest', { x: 'y' }, true, true);
    });
    expect(seen.at(-1)).not.toBe(seen[0]);
  });
});
