import { Badge, Button, Card, Icon, iconPencil, iconTrash, useToast } from '@qm/ui';
import { SortableList, slotAtPoint, type SortableItem } from '@qm/ui/sortable';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from '../../../../lib/translation.tsx';
import { useIsPhone } from '../../../../lib/viewport.ts';
import { FieldEditor } from './FieldEditor.tsx';
import {
  MAX_FIELDS,
  fieldWarnings,
  hasOptions,
  insertField,
  newField,
  type BuilderField,
  type FieldType,
} from './fields.ts';
import { LibraryPalette } from './LibraryPalette.tsx';

export interface FormBuilderProps {
  /** The draft's field list, exactly as `api.save_form_draft` takes it. */
  fields: BuilderField[];
  onChange: (fields: BuilderField[]) => void;
  /** Health-tagged orgs collect sensitive answers as a short reason only; shown as a warning. */
  healthTagged?: boolean;
  disabled?: boolean;
}

/**
 * Drag-and-drop form builder (B2); at phone width dragging is off and tap and the move buttons remain. Controlled: the page owns the draft and saves it. Library
 * types are added by tap, keyboard or a mouse drag; fields reorder by drag, keyboard or the
 * move buttons; removing a field offers undo. Wrap in a `ToastProvider` (the app root has one).
 */
export function FormBuilder({
  fields,
  onChange,
  healthTagged = false,
  disabled = false,
}: FormBuilderProps) {
  const { t } = useTranslation('admin-form-builder');
  const toast = useToast();
  const phone = useIsPhone();
  const [editing, setEditing] = useState<string | null>(null);
  const [target, setTarget] = useState(false);
  const canvas = useRef<HTMLDivElement>(null);
  // Undo outlives the render that removed the field, so it reads the latest list from here.
  const latest = useRef({ fields, onChange });
  useEffect(() => {
    latest.current = { fields, onChange };
  });

  const full = fields.length >= MAX_FIELDS;
  const typeName = (type: FieldType) => t(`types.${type}`);

  function add(type: FieldType, index = fields.length) {
    const starter = hasOptions(type) ? [t('starter.option1'), t('starter.option2')] : [];
    const field = newField(
      type,
      fields.map((f) => f.key),
      t(`starter.${type}`),
      starter,
    );
    onChange(insertField(fields, field, index));
    setEditing(field.key);
  }

  function overCanvas(x: number, y: number) {
    const box = canvas.current?.getBoundingClientRect();
    return !!box && x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
  }

  function dropAt(type: FieldType, x: number, y: number) {
    if (!overCanvas(x, y) || full) return;
    const rows = [...(canvas.current?.querySelectorAll('[data-sortable-item]') ?? [])].map((r) =>
      r.getBoundingClientRect(),
    );
    add(type, slotAtPoint(rows, y));
  }

  function remove(field: BuilderField) {
    const index = fields.findIndex((f) => f.key === field.key);
    onChange(fields.filter((f) => f.key !== field.key));
    if (editing === field.key) setEditing(null);
    toast.undo(t('canvas.removed', { name: field.label || typeName(field.type) }), () => {
      const now = latest.current;
      now.onChange(insertField(now.fields, field, index));
    });
  }

  const items: SortableItem[] = fields.map((field) => {
    const name = field.label || typeName(field.type);
    return {
      id: field.key,
      label: name,
      children: (
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium">{name}</p>
            <p className="flex flex-wrap items-center gap-2 text-sm text-muted">
              {typeName(field.type)}
              {field.required ? <Badge>{t('canvas.required')}</Badge> : null}
              {field.visibility === 'staff_only' ? <Badge>{t('canvas.staffOnly')}</Badge> : null}
              {field.sensitivity && field.sensitivity !== 'normal' ? (
                <Badge tone={field.sensitivity === 'sensitive' ? 'warning' : 'info'}>
                  {t(
                    field.sensitivity === 'sensitive'
                      ? 'editor.sensitivity_sensitive'
                      : 'editor.sensitivity_personal',
                  )}
                </Badge>
              ) : null}
            </p>
          </div>
          <Button
            variant="quiet"
            disabled={disabled}
            aria-label={t('canvas.edit', { name })}
            aria-expanded={editing === field.key}
            className="min-w-target px-0"
            onClick={() => setEditing(editing === field.key ? null : field.key)}
          >
            <Icon icon={iconPencil} />
          </Button>
          <Button
            variant="quiet"
            disabled={disabled}
            aria-label={t('canvas.remove', { name })}
            className="min-w-target px-0"
            onClick={() => remove(field)}
          >
            <Icon icon={iconTrash} />
          </Button>
        </div>
      ),
    };
  });

  const strings = {
    handle: (l: string) => t('sortable.handle', { name: l }),
    moveUp: (l: string) => t('sortable.moveUp', { name: l }),
    moveDown: (l: string) => t('sortable.moveDown', { name: l }),
    grabbed: (l: string, pos: number, total: number) =>
      t('sortable.grabbed', { name: l, pos, total }),
    moved: (l: string, pos: number, total: number) => t('sortable.moved', { name: l, pos, total }),
    dropped: (l: string, pos: number, total: number) =>
      t('sortable.dropped', { name: l, pos, total }),
    cancelled: (l: string) => t('sortable.cancelled', { name: l }),
  };
  const open = fields.find((f) => f.key === editing);
  const anySensitive = fields.some((f) => fieldWarnings(f, healthTagged).length > 0);

  return (
    <div className="flex flex-col gap-4">
      <section aria-labelledby="builder-library" className="flex flex-col gap-2">
        <h2 id="builder-library" className="font-semibold">
          {t('library.title')}
        </h2>
        <p className="text-sm text-muted">{t('library.intro')}</p>
        <LibraryPalette
          disabled={disabled || full}
          draggable={!phone}
          onAdd={(type) => add(type)}
          onDrop={dropAt}
          onDrag={(point) => setTarget(!!point && overCanvas(point.x, point.y))}
        />
        {full ? (
          <p role="status" className="text-sm font-medium text-warning-strong">
            {t('library.full', { max: MAX_FIELDS })}
          </p>
        ) : null}
      </section>

      <section aria-labelledby="builder-canvas" className="flex flex-col gap-2">
        <h2 id="builder-canvas" className="font-semibold">
          {t('canvas.title', { count: fields.length, max: MAX_FIELDS })}
        </h2>
        {anySensitive ? (
          <p role="status" className="rounded-control bg-warning-soft p-3 text-warning-strong">
            {t('warnings.formHasSensitive')}
          </p>
        ) : null}
        <div
          ref={canvas}
          className={`rounded-card ${target ? 'outline-2 outline-offset-2 outline-primary' : ''}`}
        >
          {fields.length === 0 ? (
            <p className="rounded-card border border-dashed border-border p-6 text-center text-muted">
              {t('canvas.empty')}
            </p>
          ) : (
            <SortableList
              label={t('canvas.label')}
              items={items}
              strings={strings}
              draggable={!phone}
              onReorder={(ids) =>
                onChange(ids.map((id) => fields.find((f) => f.key === id)!).filter(Boolean))
              }
            />
          )}
        </div>
      </section>

      {open ? (
        <Card aria-label={t('editor.title', { name: open.label || typeName(open.type) })}>
          <h2 className="mb-3 font-semibold">{typeName(open.type)}</h2>
          <FieldEditor
            key={open.key}
            field={open}
            healthTagged={healthTagged}
            onChange={(next) => onChange(fields.map((f) => (f.key === next.key ? next : f)))}
          />
        </Card>
      ) : null}
    </div>
  );
}
