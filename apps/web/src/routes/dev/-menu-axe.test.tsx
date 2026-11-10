import { Menu, Popover } from '@qm/ui';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it } from 'vitest';

afterEach(cleanup);

// DS-9 (#1013): the open states are not on the gallery page at rest, so axe runs on them here.
describe('Menu and Popover axe', () => {
  it('has no serious or critical violations with the menu and popover open', async () => {
    const { container } = render(
      <main>
        <h1>Row</h1>
        <Menu
          label="More actions"
          items={[
            { id: 'move', label: 'Move', onSelect: () => undefined },
            {
              id: 'remove',
              label: 'Remove',
              confirm: {
                title: 'Remove?',
                confirmLabel: 'Remove',
                cancelLabel: 'Keep',
                onConfirm: () => undefined,
              },
            },
          ]}
        />
        <Popover triggerLabel="Filters" trigger="Filters">
          <p>Panel</p>
        </Popover>
      </main>,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(screen.getByRole('button', { name: 'Filters' }));
    const results = await axe.run(container);
    const blocking = results.violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
    expect(blocking).toEqual([]);
  });
});
