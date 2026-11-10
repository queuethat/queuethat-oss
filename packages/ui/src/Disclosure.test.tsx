import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Disclosure } from './Disclosure.tsx';

afterEach(cleanup);

describe('Disclosure', () => {
  it('starts closed: the toggle says so and the content is not rendered', () => {
    render(
      <Disclosure title="More options">
        <p>Advanced</p>
      </Disclosure>,
    );
    const toggle = screen.getByRole('button', { name: 'More options' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-controls')).toBeNull();
    expect(screen.queryByText('Advanced')).toBeNull();
  });

  it('opens and closes with the toggle, pointing aria-controls at the open panel', async () => {
    render(
      <Disclosure title="More options">
        <p>Advanced</p>
      </Disclosure>,
    );
    const toggle = screen.getByRole('button', { name: 'More options' });
    await userEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const panel = screen.getByText('Advanced').parentElement!;
    expect(toggle.getAttribute('aria-controls')).toBe(panel.id);
    await userEvent.click(toggle);
    expect(screen.queryByText('Advanced')).toBeNull();
  });

  it('can start open', () => {
    render(
      <Disclosure title="More options" defaultOpen>
        <p>Advanced</p>
      </Disclosure>,
    );
    expect(screen.getByText('Advanced')).toBeTruthy();
  });

  it('follows the open prop when controlled, and reports each request to change', async () => {
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <Disclosure title="More options" open={false} onOpenChange={onOpenChange}>
        <p>Advanced</p>
      </Disclosure>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'More options' }));
    expect(onOpenChange).toHaveBeenCalledWith(true);
    expect(screen.queryByText('Advanced')).toBeNull();

    rerender(
      <Disclosure title="More options" open onOpenChange={onOpenChange}>
        <p>Advanced</p>
      </Disclosure>,
    );
    expect(screen.getByText('Advanced')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'More options' }));
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it('lets a parent keep it open, for example while a hidden field is invalid', async () => {
    function Host({ invalid }: { invalid: boolean }) {
      const [more, setMore] = useState(false);
      return (
        <Disclosure title="More options" open={more || invalid} onOpenChange={setMore}>
          <p>Advanced</p>
        </Disclosure>
      );
    }
    const { rerender } = render(<Host invalid />);
    await userEvent.click(screen.getByRole('button', { name: 'More options' }));
    expect(screen.getByText('Advanced')).toBeTruthy();

    rerender(<Host invalid={false} />);
    expect(screen.queryByText('Advanced')).toBeNull();
  });
});
