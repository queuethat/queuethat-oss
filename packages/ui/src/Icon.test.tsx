import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Icon } from './Icon.tsx';
import * as icons from './icons.ts';

afterEach(cleanup);

describe('Icon', () => {
  it('is hidden from assistive tech by default', () => {
    const { container } = render(<Icon icon={icons.iconCheck} />);
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
    expect(svg?.getAttribute('role')).toBeNull();
    expect(svg?.getAttribute('focusable')).toBe('false');
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('exposes an image with a name when label is given', () => {
    render(<Icon icon={icons.iconWifiOff} label="Offline" />);
    const img = screen.getByRole('img', { name: 'Offline' });
    expect(img.getAttribute('aria-hidden')).toBeNull();
  });

  it('ships non-empty path data for every icon', () => {
    for (const [name, d] of Object.entries(icons)) {
      expect(typeof d, name).toBe('string');
      expect((d as string).length, name).toBeGreaterThan(5);
    }
  });
});
