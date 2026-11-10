import { useState } from 'react';
import { Button } from '../Button.tsx';
import { Icon } from '../Icon.tsx';

const iconPlus = 'M12 5v14M5 12h14';

export interface LibraryItem {
  id: string;
  label: string;
}

export interface SortableLibraryProps {
  /** Accessible name of the group, already through t(). */
  label: string;
  items: readonly LibraryItem[];
  /** Tapping or pressing an item adds it; the owner decides where it lands. */
  onAdd: (id: string) => void;
  strings: { add: (label: string) => string; added: (label: string) => string };
}

/** Palette that feeds a `SortableList`: tap-to-add is the drag alternative (WCAG 2.2 2.5.7). */
export function SortableLibrary({ label, items, onAdd, strings }: SortableLibraryProps) {
  const [message, setMessage] = useState('');
  return (
    <div>
      <ul aria-label={label} className="flex flex-wrap gap-2">
        {items.map((item) => (
          <li key={item.id}>
            <Button
              variant="secondary"
              aria-label={strings.add(item.label)}
              onClick={() => {
                onAdd(item.id);
                setMessage(strings.added(item.label));
              }}
            >
              <Icon icon={iconPlus} size="sm" />
              {item.label}
            </Button>
          </li>
        ))}
      </ul>
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {message}
      </div>
    </div>
  );
}
