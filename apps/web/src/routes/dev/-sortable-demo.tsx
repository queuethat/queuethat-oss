import { SortableLibrary, SortableList, type SortableItem } from '@qm/ui/sortable';
import { useState } from 'react';

const library = ['Short text', 'Yes / no', 'Date'].map((label) => ({ id: label, label }));
const strings = {
  handle: (l: string) => `Reorder ${l}`,
  moveUp: (l: string) => `Move ${l} up`,
  moveDown: (l: string) => `Move ${l} down`,
  grabbed: (l: string, p: number, n: number) => `${l} picked up, ${p} of ${n}. Arrows move.`,
  moved: (l: string, p: number, n: number) => `${l} moved to ${p} of ${n}`,
  dropped: (l: string, p: number, n: number) => `${l} dropped at ${p} of ${n}`,
  cancelled: (l: string) => `${l} reorder cancelled`,
};

export default function SortableDemo() {
  const [items, setItems] = useState<SortableItem[]>([{ id: 'name', label: 'Your name' }]);
  const add = (label: string) =>
    setItems((cur) => [...cur, { id: `${label}-${cur.length}`, label }]);
  const strs = { add: (l: string) => `Add ${l}`, added: (l: string) => `${l} added` };
  return (
    <div className="flex flex-col gap-3">
      <SortableLibrary label="Field types" items={library} strings={strs} onAdd={add} />
      <SortableList
        label="Form fields"
        items={items}
        strings={strings}
        onReorder={(ids) => setItems((cur) => ids.map((id) => cur.find((c) => c.id === id)!))}
      />
    </div>
  );
}
