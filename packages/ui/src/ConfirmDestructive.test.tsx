import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfirmDestructive } from './ConfirmDestructive.tsx';

afterEach(cleanup);

function setup(onConfirm: () => void | Promise<unknown> = vi.fn()) {
  render(
    <ConfirmDestructive
      triggerLabel="Remove"
      title="Remove A012?"
      description="They lose their place."
      confirmLabel="Yes, remove"
      cancelLabel="Keep"
      onConfirm={onConfirm}
    />,
  );
  return { user: userEvent.setup(), onConfirm };
}

describe('ConfirmDestructive', () => {
  it('does nothing destructive when the trigger is tapped, even twice', async () => {
    const { user, onConfirm } = setup();
    const trigger = screen.getByRole('button', { name: 'Remove' });
    await user.click(trigger);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Remove A012?' })).toBeTruthy();
    await user.dblClick(trigger);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('fires once only after confirm is tapped, then closes', async () => {
    const { user, onConfirm } = setup();
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    await user.click(screen.getByRole('button', { name: 'Yes, remove' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('puts focus on cancel, so Enter cancels instead of confirming', async () => {
    const { user, onConfirm } = setup();
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Keep' }));
    await user.keyboard('{Enter}');
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes on Escape without confirming', async () => {
    const { user, onConfirm } = setup();
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    // jsdom doesn't map Escape to the dialog's cancel event; browsers do.
    act(() => {
      screen.getByRole('dialog').dispatchEvent(new Event('cancel', { cancelable: true }));
    });
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('stays open and blocks a second confirm while the action is pending', async () => {
    let resolve!: () => void;
    const onConfirm = vi.fn(() => new Promise<void>((r) => (resolve = r)));
    const { user } = setup(onConfirm);
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    const confirm = screen.getByRole('button', { name: /Yes, remove/ });
    await user.click(confirm);
    await user.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('dialog')).toBeTruthy();
    resolve();
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('keeps confirm disabled until the dialog content is complete', async () => {
    const onConfirm = vi.fn();
    const { rerender } = render(
      <ConfirmDestructive
        triggerLabel="Remove"
        triggerAriaLabel="Remove A012"
        title="Remove A012?"
        confirmLabel="Yes, remove"
        cancelLabel="Keep"
        onConfirm={onConfirm}
        confirmDisabled
      >
        <p>Why?</p>
      </ConfirmDestructive>,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Remove A012' }));
    expect(screen.getByRole('dialog').textContent).toContain('Why?');
    await user.click(screen.getByRole('button', { name: 'Yes, remove' }));
    expect(onConfirm).not.toHaveBeenCalled();
    rerender(
      <ConfirmDestructive
        triggerLabel="Remove"
        triggerAriaLabel="Remove A012"
        title="Remove A012?"
        confirmLabel="Yes, remove"
        cancelLabel="Keep"
        onConfirm={onConfirm}
      >
        <p>Why?</p>
      </ConfirmDestructive>,
    );
    await user.click(screen.getByRole('button', { name: 'Yes, remove' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
