import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { LinkButton } from './LinkButton.tsx';

describe('LinkButton', () => {
  afterEach(cleanup);

  it('renders an anchor with button sizing', () => {
    render(<LinkButton href="/x">Go</LinkButton>);
    const link = screen.getByRole('link', { name: 'Go' });
    expect(link.getAttribute('href')).toBe('/x');
    expect(link.className).toContain('min-h-target');
    expect(link.className).toContain('bg-primary');
  });

  it('applies the secondary variant', () => {
    render(
      <LinkButton variant="secondary" href="/x">
        Go
      </LinkButton>,
    );
    expect(screen.getByRole('link').className).toContain('bg-secondary');
  });

  it('lets the caller render the element', () => {
    render(
      <LinkButton
        render={({ className, children }) => (
          <a data-router="1" href="/r" className={className}>
            {children}
          </a>
        )}
      >
        Route
      </LinkButton>,
    );
    const link = screen.getByRole('link', { name: 'Route' });
    expect(link.getAttribute('data-router')).toBe('1');
    expect(link.className).toContain('min-h-target');
  });
});
