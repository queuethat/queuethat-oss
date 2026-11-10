import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type UniqueIdentifier,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Button } from '@qm/ui';
import type { ReactNode } from 'react';
import { useTranslation } from '../../../lib/translation.tsx';

/**
 * Drag-and-drop ordering for the waiting list (#135). Pointer, touch (press-and-hold, so a scroll
 * still scrolls) and keyboard (space, arrows, space) all end in `onMove(id, toIndex)`; what the
 * move means is the database's call (`move_visit`).
 */
export function SortableWaiting({
  ids,
  labelOf,
  onMove,
  children,
}: {
  ids: string[];
  /** The ticket shown to screen readers for an id. */
  labelOf: (id: string) => string;
  onMove: (id: string, toIndex: number) => void;
  children: ReactNode;
}) {
  const { t } = useTranslation('staff');
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const name = (id: UniqueIdentifier) => labelOf(String(id));
  const position = (id: UniqueIdentifier | undefined) => ids.indexOf(String(id)) + 1;
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (over && active.id !== over.id) onMove(String(active.id), ids.indexOf(String(over.id)));
  };
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={onDragEnd}
      accessibility={{
        screenReaderInstructions: { draggable: t('console.reorder.instructions') },
        announcements: {
          onDragStart: ({ active }) => t('console.reorder.picked', { ticket: name(active.id) }),
          onDragOver: ({ active, over }) =>
            over
              ? t('console.reorder.over', { ticket: name(active.id), position: position(over.id) })
              : undefined,
          onDragEnd: ({ active, over }) =>
            over
              ? t('console.reorder.dropped', {
                  ticket: name(active.id),
                  position: position(over.id),
                })
              : t('console.reorder.cancelled', { ticket: name(active.id) }),
          onDragCancel: ({ active }) => t('console.reorder.cancelled', { ticket: name(active.id) }),
        },
      }}
    >
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <ol className="flex flex-col gap-2">{children}</ol>
      </SortableContext>
    </DndContext>
  );
}

/**
 * One waiting row's `li`, draggable by `grip` (a button, so the drag has a keyboard and screen
 * reader entry). `children` receives the grip to place and whether the row is being dragged.
 */
export function SortableRow({
  id,
  gripLabel,
  gripText,
  children,
}: {
  id: string;
  gripLabel: string;
  gripText: string;
  children: (row: { grip: ReactNode; dragging: boolean }) => ReactNode;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });
  return (
    <li
      data-testid="visit"
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      {children({
        dragging: isDragging,
        grip: (
          <Button
            variant="secondary"
            className="touch-none px-3"
            ref={setActivatorNodeRef}
            aria-label={gripLabel}
            {...attributes}
            {...listeners}
          >
            {gripText}
          </Button>
        ),
      })}
    </li>
  );
}
