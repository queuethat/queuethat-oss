import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { Tabs } from './Tabs.tsx';

afterEach(cleanup);

function Harness() {
  const [value, setValue] = useState('a');
  return (
    <Tabs
      label="Queues"
      panelId="panel"
      value={value}
      onChange={setValue}
      items={[
        { id: 'a', label: 'Walk-ins' },
        { id: 'b', label: 'Kids' },
        { id: 'c', label: 'Colour' },
      ]}
    />
  );
}

describe('Tabs', () => {
  it('selects on click and keeps a single tab stop', async () => {
    render(<Harness />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: 'Kids' }));
    expect(screen.getByRole('tab', { selected: true }).textContent).toBe('Kids');
    expect(screen.getAllByRole('tab').map((t) => t.tabIndex)).toEqual([-1, 0, -1]);
    expect(screen.getByRole('tab', { name: 'Kids' }).getAttribute('aria-controls')).toBe('panel');
  });

  it('moves and selects with arrow keys, wrapping, and Home/End', async () => {
    render(<Harness />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: 'Walk-ins' }));
    await user.keyboard('{ArrowLeft}');
    expect(document.activeElement?.textContent).toBe('Colour');
    expect(screen.getByRole('tab', { selected: true }).textContent).toBe('Colour');
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { selected: true }).textContent).toBe('Walk-ins');
    await user.keyboard('{End}');
    expect(screen.getByRole('tab', { selected: true }).textContent).toBe('Colour');
    await user.keyboard('{Home}');
    expect(document.activeElement?.textContent).toBe('Walk-ins');
  });
});
