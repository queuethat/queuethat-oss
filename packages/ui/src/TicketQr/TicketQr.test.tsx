import { cleanup, render, screen } from '@testing-library/react';
import jsQR from 'jsqr';
import { afterEach, describe, expect, it } from 'vitest';
import { TicketQr } from './TicketQr.tsx';

afterEach(cleanup);

/** Rasterises the rendered SVG path back to pixels, the way a camera would see it. */
function decode(svg: SVGSVGElement): string | null {
  const size = Number(svg.getAttribute('viewBox')!.split(' ')[2]);
  const scale = 8;
  const px = size * scale;
  const data = new Uint8ClampedArray(px * px * 4).fill(255);
  for (const [, x, y] of svg
    .querySelector('path')!
    .getAttribute('d')!
    .matchAll(/M(\d+) (\d+)h1v1h-1z/g)) {
    for (let dy = 0; dy < scale; dy++) {
      for (let dx = 0; dx < scale; dx++) {
        const i = ((Number(y) * scale + dy) * px + Number(x) * scale + dx) * 4;
        data[i] = data[i + 1] = data[i + 2] = 0;
      }
    }
  }
  return jsQR(data, px, px)?.data ?? null;
}

describe('TicketQr', () => {
  it('encodes exactly the scan code value (AC1), never a token', () => {
    const token = 'tok_0123456789abcdef0123456789abcdef';
    render(
      <TicketQr value="qm:7K2M9P4X1Q" ticket="A042" code="7K2M9P4X1Q" label="QR code for A042" />,
    );
    const svg = screen.getByTestId('ticket-qr') as unknown as SVGSVGElement;
    const decoded = decode(svg);
    expect(decoded).toBe('qm:7K2M9P4X1Q');
    expect(decoded).not.toContain(token);
  });

  it('shows the ticket and the code as text for manual entry', () => {
    render(<TicketQr value="qm:ABC" ticket="A042" code="ABC" label="QR" />);
    expect(screen.getByText('A042')).toBeTruthy();
    expect(screen.getByTestId('ticket-qr-code').textContent).toBe('ABC');
    expect(screen.getByRole('img', { name: 'QR' })).toBeTruthy();
  });
});
