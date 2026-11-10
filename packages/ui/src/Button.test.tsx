import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Button, type ButtonVariant } from './Button.tsx';

afterEach(cleanup);

const VARIANTS: ButtonVariant[] = ['primary', 'secondary', 'destructive', 'quiet'];

describe('Button', () => {
  it('is type=button, so it never submits a form by accident', () => {
    render(<Button>Save</Button>);
    expect(screen.getByRole('button', { name: 'Save' }).getAttribute('type')).toBe('button');
  });

  it('fills the primary variant and leaves the quiet one unfilled until hovered', () => {
    render(
      <>
        <Button>Call</Button>
        <Button variant="quiet">Notes</Button>
      </>,
    );
    expect(screen.getByRole('button', { name: 'Call' }).className).toContain('bg-primary');
    const quiet = screen.getByRole('button', { name: 'Notes' }).className;
    expect(quiet).toContain('bg-transparent');
    expect(quiet).toContain('hover:bg-secondary');
    expect(quiet).not.toContain('bg-primary');
  });

  it.each(VARIANTS)('keeps the 48px touch target on the %s variant', (variant) => {
    render(<Button variant={variant}>Action</Button>);
    expect(screen.getByRole('button', { name: 'Action' }).className).toContain('min-h-target');
  });

  it('runs onClick, and does not while loading', async () => {
    const onClick = vi.fn();
    const { rerender } = render(<Button onClick={onClick}>Go</Button>);
    await userEvent.click(screen.getByRole('button', { name: 'Go' }));
    expect(onClick).toHaveBeenCalledTimes(1);

    rerender(
      <Button loading loadingLabel="Saving" onClick={onClick}>
        Go
      </Button>,
    );
    const busy = screen.getByRole('button');
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(busy);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
