import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Mark } from './Mark.tsx';

afterEach(cleanup);

describe('Mark', () => {
  it('is hidden from assistive tech by default', () => {
    const { container } = render(<Mark />);
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
    expect(svg?.getAttribute('role')).toBeNull();
    expect(svg?.getAttribute('focusable')).toBe('false');
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('exposes an image with a name when label is given', () => {
    render(<Mark label="QueueThat" />);
    const img = screen.getByRole('img', { name: 'QueueThat' });
    expect(img.getAttribute('aria-hidden')).toBeNull();
  });

  it('is square at the requested size and 28 px by default', () => {
    const { container, rerender } = render(<Mark />);
    expect(container.querySelector('svg')?.getAttribute('width')).toBe('28');
    expect(container.querySelector('svg')?.getAttribute('height')).toBe('28');
    rerender(<Mark size={36} />);
    expect(container.querySelector('svg')?.getAttribute('width')).toBe('36');
    expect(container.querySelector('svg')?.getAttribute('height')).toBe('36');
  });

  it('keeps its brand fills whatever the surrounding text colour is', () => {
    const { container } = render(<Mark className="text-danger" />);
    const fills = [...container.querySelectorAll('[fill]')].map((n) => n.getAttribute('fill'));
    expect(fills).toContain('#15171C');
    expect(fills).toContain('#5FC4B2');
    expect(container.innerHTML).not.toContain('currentColor');
  });
});
