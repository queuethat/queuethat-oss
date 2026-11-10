import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Menu, type MenuItem } from './Menu.tsx';
import { Popover } from './Popover.tsx';

afterEach(cleanup);

function setup(onRemove = vi.fn(), onMove = vi.fn()) {
  const items: MenuItem[] = [
    { id: 'move', label: 'Move', onSelect: onMove },
    { id: 'transfer', label: 'Transfer', disabled: true, onSelect: vi.fn() },
    { id: 'priority', label: 'Priority', onSelect: vi.fn() },
    {
      id: 'remove',
      label: 'Remove',
      confirm: {
        title: 'Remove Maya, A-042?',
        confirmLabel: 'Remove',
        cancelLabel: 'Keep',
        onConfirm: onRemove,
      },
    },
  ];
  render(<Menu label="More actions for A-042" items={items} />);
  return { onRemove, onMove, user: userEvent.setup() };
}

describe('Menu', () => {
  it('opens with the keyboard, focuses the first enabled item and wraps with arrows', async () => {
    const { user } = setup();
    const trigger = screen.getByRole('button', { name: 'More actions for A-042' });
    trigger.focus();
    await user.keyboard('{ArrowDown}');
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Move' }));
    await user.keyboard('{ArrowDown}'); // skips the disabled Transfer
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Priority' }));
    await user.keyboard('{End}');
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Remove' }));
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Move' }));
  });

  it('moves to the item matching typed letters', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: 'More actions for A-042' }));
    await user.keyboard('p');
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Priority' }));
  });

  it('Escape closes and returns focus to the trigger', async () => {
    const { user } = setup();
    const trigger = screen.getByRole('button', { name: 'More actions for A-042' });
    await user.click(trigger);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('runs a plain action and closes', async () => {
    const { user, onMove } = setup();
    await user.click(screen.getByRole('button', { name: 'More actions for A-042' }));
    await user.click(screen.getByRole('menuitem', { name: 'Move' }));
    expect(onMove).toHaveBeenCalledOnce();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('never fires a destructive item without the separate confirm tap (I-9)', async () => {
    const { user, onRemove } = setup();
    await user.click(screen.getByRole('button', { name: 'More actions for A-042' }));
    await user.click(screen.getByRole('menuitem', { name: 'Remove' }));
    expect(onRemove).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('dialog', { name: 'Remove Maya, A-042?' });
    expect(dialog).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Keep' }));
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    expect(onRemove).toHaveBeenCalledOnce();
  });

  it('closes on a press outside', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: 'More actions for A-042' }));
    await user.click(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

describe('Popover', () => {
  it('toggles, and Escape returns focus to the trigger', async () => {
    render(
      <Popover triggerLabel="Filters">
        <p>Panel</p>
      </Popover>,
    );
    const user = userEvent.setup();
    const trigger = screen.getByRole('button', { name: 'Filters' });
    await user.click(trigger);
    expect(screen.getByText('Panel')).toBeTruthy();
    await user.keyboard('{Escape}');
    expect(screen.queryByText('Panel')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
