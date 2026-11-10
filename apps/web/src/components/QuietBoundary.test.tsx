import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QuietBoundary } from './QuietBoundary.tsx';

afterEach(cleanup);

function Boom(): never {
  throw new Error('chunk failed');
}

describe('QuietBoundary', () => {
  it('shows its children', () => {
    render(<QuietBoundary>fine</QuietBoundary>);
    expect(screen.getByText('fine')).toBeTruthy();
  });

  it('shows nothing, and keeps its siblings, when a child throws', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <div>
        <QuietBoundary>
          <Boom />
        </QuietBoundary>
        <p>still here</p>
      </div>,
    );
    expect(screen.getByText('still here')).toBeTruthy();
  });
});
