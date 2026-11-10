import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, render } from '@testing-library/react';
import { Mark } from '@qm/ui';
import { afterEach, describe, expect, it } from 'vitest';

// The mark is drawn once in packages/ui (Mark.tsx) and once as a static file the browser fetches for
// the tab icon (public/favicon.svg), because a static file cannot import a component. These tests are
// what keeps the two from drifting apart, and what keeps the PNG icons the sizes the manifest declares.

afterEach(cleanup);

const publicPath = (name: string) => join(import.meta.dirname, '..', 'public', name);

/** Each shape as `tag attr=value ...`, so two drawings compare whichever way the markup was written. */
function shapes(svg: Element): string[] {
  return [...svg.querySelectorAll('rect, circle')].map(
    (el) =>
      `${el.tagName.toLowerCase()} ${[...el.attributes]
        .map((a) => `${a.name}=${a.value}`)
        .sort()
        .join(' ')}`,
  );
}

describe('the mark', () => {
  it('is drawn the same in Mark.tsx and in public/favicon.svg', () => {
    const file = new DOMParser().parseFromString(
      readFileSync(publicPath('favicon.svg'), 'utf8'),
      'image/svg+xml',
    ).documentElement;
    const { container } = render(<Mark />);
    const component = container.querySelector('svg')!;

    expect(file.getAttribute('viewBox')).toBe(component.getAttribute('viewBox'));
    expect(shapes(file)).toEqual(shapes(component));
    expect(shapes(file)).toHaveLength(4);
  });
});

describe('the PNG icons', () => {
  /** Width and height from the PNG header: an 8 byte signature, then IHDR with both as 32-bit values. */
  function size(name: string): [number, number] {
    const bytes = readFileSync(publicPath(name));
    expect(bytes.subarray(1, 4).toString('ascii'), `${name} is a PNG`).toBe('PNG');
    return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
  }

  // The sizes vite.config.ts lists in the manifest, and the touch icon index.html links to.
  it.each([
    ['apple-touch-icon-180x180.png', 180],
    ['pwa-192x192.png', 192],
    ['pwa-512x512.png', 512],
    ['maskable-512x512.png', 512],
  ] as const)('%s is %i px square', (name, edge) => {
    expect(size(name)).toEqual([edge, edge]);
  });
});
