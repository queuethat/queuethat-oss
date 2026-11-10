import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SortableLibrary, SortableList } from './index.ts';

afterEach(cleanup);

const strings = {
  handle: (l: string) => `Reorder ${l}`,
  moveUp: (l: string) => `Move ${l} up`,
  moveDown: (l: string) => `Move ${l} down`,
  grabbed: (l: string, p: number, n: number) => `Picked up ${l}, ${p} of ${n}`,
  moved: (l: string, p: number, n: number) => `${l} moved to ${p} of ${n}`,
  dropped: (l: string, p: number, n: number) => `${l} dropped at ${p} of ${n}`,
  cancelled: (l: string) => `${l} reorder cancelled`,
};
const data = ['A', 'B', 'C'].map((id) => ({ id, label: `Field ${id}` }));

function Harness({
  onChange,
  draggable,
}: {
  onChange?: (ids: string[]) => void;
  draggable?: boolean;
}) {
  const [items, setItems] = useState(data);
  const onReorder = (ids: string[]) => {
    setItems(ids.map((id) => data.find((d) => d.id === id)!));
    onChange?.(ids);
  };
  return (
    <SortableList
      label="Fields"
      items={items}
      strings={strings}
      draggable={draggable}
      onReorder={onReorder}
    />
  );
}
const first = () => screen.getAllByRole('listitem')[0]?.textContent;
const said = () => screen.getByRole('status').textContent;
const btn = (name: string) => screen.getByRole('button', { name });

describe('SortableList', () => {
  it('move buttons are 48px targets that reorder, announce and keep focus', async () => {
    const spy = vi.fn();
    render(<Harness onChange={spy} />);
    expect(btn('Move Field A up').getAttribute('aria-disabled')).toBe('true');
    await userEvent.click(btn('Move Field A up'));
    expect(spy).not.toHaveBeenCalled();
    expect(btn('Move Field A down').className).toContain('min-h-target');
    await userEvent.click(btn('Move Field A down'));
    expect(first()).toContain('Field B');
    expect(said()).toBe('Field A moved to 2 of 3');
    expect(document.activeElement).toBe(btn('Move Field A down'));
  });

  it('reorders by keyboard: grab, arrows, drop; arrows do nothing until grabbed', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    btn('Reorder Field A').focus();
    await user.keyboard('{ArrowDown}');
    expect(first()).toContain('Field A');
    await user.keyboard(' ');
    expect(said()).toBe('Picked up Field A, 1 of 3');
    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(said()).toBe('Field A moved to 3 of 3');
    expect(document.activeElement).toBe(btn('Reorder Field A'));
    await user.keyboard(' ');
    expect(said()).toBe('Field A dropped at 3 of 3');
    await user.keyboard(' {ArrowUp}{Escape}');
    expect(said()).toBe('Field A reorder cancelled');
  });

  it('reorders by pointer drag using row positions', () => {
    const spy = vi.fn();
    render(<Harness onChange={spy} />);
    screen.getAllByRole('listitem').forEach((li, i) => {
      li.getBoundingClientRect = () => ({ top: i * 60, height: 50 }) as DOMRect;
    });
    const handle = btn('Reorder Field A');
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientY: 170, pointerId: 1 });
    fireEvent.pointerUp(handle, { pointerId: 1 });
    expect(spy).toHaveBeenCalledWith(['B', 'C', 'A']);
    expect(said()).toBe('Field A dropped at 3 of 3');
  });
});

describe('SortableList without drag', () => {
  it('shows no handles but the move buttons still reorder', async () => {
    render(<Harness draggable={false} />);
    expect(screen.queryByRole('button', { name: /^Reorder / })).toBeNull();
    await userEvent.click(btn('Move Field A down'));
    expect(first()).toContain('Field B');
    expect(said()).toBe('Field A moved to 2 of 3');
  });
});

describe('SortableLibrary', () => {
  it('adds on tap with a 48px target and announces', async () => {
    const onAdd = vi.fn();
    const str = { add: (l: string) => `Add ${l}`, added: (l: string) => `${l} added` };
    render(
      <SortableLibrary
        label="Types"
        items={[{ id: 't', label: 'Text' }]}
        onAdd={onAdd}
        strings={str}
      />,
    );
    expect(btn('Add Text').className).toContain('min-h-target');
    await userEvent.click(btn('Add Text'));
    expect(onAdd).toHaveBeenCalledWith('t');
    expect(said()).toBe('Text added');
  });
});
