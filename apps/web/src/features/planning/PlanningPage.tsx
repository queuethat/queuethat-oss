import { Button, EmptyState, Input, Spinner } from '@qm/ui';
import { useState } from 'react';
import { useTranslation } from '../../lib/translation.tsx';
import { useNow } from '../../lib/now.ts';
import { useCurrentLocation, useCurrentOrg } from '../auth/current.ts';
import { canManageQueues } from '../admin/queues/api.ts';
import { addDays, formatTime, localDate } from '../booking/slots.ts';
import { usePlanning, type PlanningData } from './api.ts';
import { BlockDialog, type BlockRequest } from './BlockDialog.tsx';
import {
  COLUMNS,
  conflictsIn,
  SLOT_MIN,
  zonedInstant,
  DAY_END_MIN,
  DAY_START_MIN,
  daysFrom,
  rowForAppointment,
  rowForShift,
  spanOnDay,
  UNASSIGNED,
  type Span,
} from './grid.ts';
import { bounds, useGridSelection } from './selection.ts';

type View = 'day' | 'week';
type Layout = 'grid' | 'table';

const pct = (n: number) => `${(n * 100).toFixed(3)}%`;
const place = (s: Span) => ({ left: pct(s.left), width: pct(s.width) });
const HATCH = 'repeating-linear-gradient(45deg, transparent 0 4px, rgb(0 0 0 / 0.18) 4px 6px)';

const CELL = 'border-l border-border/30';
const CELL_PICKED = 'bg-primary/25';
const CELL_CURSOR = 'outline outline-2 -outline-offset-2 outline-primary';
const ITEM_CLASS = {
  shift: 'pointer-events-none absolute inset-y-0 bg-success-soft opacity-60',
  block:
    'pointer-events-none absolute inset-y-1 overflow-hidden rounded bg-surface-raised px-1 text-xs',
  appointment:
    'pointer-events-none absolute inset-y-2 overflow-hidden rounded bg-primary px-1 text-xs text-on-primary',
} as const;

interface Item {
  kind: 'appointment' | 'block' | 'shift';
  row: string;
  start: string;
  end: string;
  text: string;
}

/** Everything the data shows on `day`, placed in rows. Shared by the grid and the table fallback. */
function itemsOn(
  data: PlanningData,
  day: string,
  tz: string,
  labels: { blocked: string; onShift: string },
): Item[] {
  const items: Item[] = [];
  for (const a of data.appointments) {
    if (!spanOnDay(a.starts_at, a.ends_at, tz, day)) continue;
    items.push({
      kind: 'appointment',
      row: rowForAppointment(a, data.resources, data.serviceResources),
      start: a.starts_at,
      end: a.ends_at,
      text: `${data.services.get(a.service_id) ?? ''} ${a.guest_name ?? ''}`.trim(),
    });
  }
  for (const b of data.blocks) {
    if (!spanOnDay(b.start, b.end, tz, day)) continue;
    items.push({
      kind: 'block',
      row: b.counter_id,
      start: b.start,
      end: b.end,
      text: b.reason ?? labels.blocked,
    });
  }
  for (const s of data.shifts) {
    const row = rowForShift(s, data.resources);
    if (!row || !spanOnDay(s.starts_at, s.ends_at, tz, day)) continue;
    items.push({
      kind: 'shift',
      row,
      start: s.starts_at,
      end: s.ends_at,
      text: s.note ?? labels.onShift,
    });
  }
  return items.sort((a, b) => a.start.localeCompare(b.start));
}

function DayGrid({
  data,
  day,
  tz,
  lang,
  onBlock,
}: {
  data: PlanningData;
  day: string;
  tz: string;
  lang: string;
  /** Present for managers: a finished selection becomes a request to block that time. */
  onBlock?: (request: BlockRequest) => void;
}) {
  const { t } = useTranslation('staff');
  const select = useGridSelection(data.resources.length, (sel) => {
    const b = bounds(sel);
    const chosen = data.resources.slice(b.r1, b.r2 + 1);
    const start = zonedInstant(day, DAY_START_MIN + b.c1 * SLOT_MIN, tz);
    const end = zonedInstant(day, DAY_START_MIN + (b.c2 + 1) * SLOT_MIN, tz);
    onBlock?.({
      resources: chosen.map((r) => ({ id: r.id, label: r.label })),
      start,
      end,
      conflicts: conflictsIn(
        data.appointments,
        new Set(chosen.map((r) => r.id)),
        { start, end },
        data.resources,
        data.serviceResources,
      ),
    });
  });
  const sb = select.selection ? bounds(select.selection) : null;
  const items = itemsOn(data, day, tz, {
    blocked: t('planning.blocked'),
    onShift: t('planning.onShift'),
  });
  const nowMs = useNow(30_000);
  const now = spanOnDay(
    new Date(nowMs).toISOString(),
    new Date(nowMs + 60_000).toISOString(),
    tz,
    day,
  );
  const rows = [
    ...data.resources.map((r) => ({ id: r.id, label: r.label })),
    ...(items.some((i) => i.row === UNASSIGNED)
      ? [{ id: UNASSIGNED, label: t('planning.unassigned') }]
      : []),
  ];
  const hours = Array.from(
    { length: (DAY_END_MIN - DAY_START_MIN) / 60 },
    (_, i) => DAY_START_MIN / 60 + i,
  );
  return (
    // The grid is a keyboard widget: arrows move, shift+arrows select (WCAG 2.5.1 alternative to dragging).
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <div
      className="overflow-x-auto"
      role="region"
      aria-label={t('planning.gridLabel', { day })}
      // A scrollable region must be keyboard reachable (axe scrollable-region-focusable).
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={0}
      onKeyDown={onBlock ? select.keyDown : undefined}
    >
      <div style={{ minWidth: `${COLUMNS * 1.5 + 8}rem` }}>
        <div className="flex">
          <div className="w-32 shrink-0" />
          <div className="relative h-6 flex-1">
            {hours.map((h) => (
              <span
                key={h}
                className="absolute text-xs text-muted"
                style={{ left: pct((h * 60 - DAY_START_MIN) / (DAY_END_MIN - DAY_START_MIN)) }}
              >
                {String(h).padStart(2, '0')}:00
              </span>
            ))}
          </div>
        </div>
        {rows.map((r, ri) => (
          <div key={r.id} className="flex border-t border-border">
            <div className="w-32 shrink-0 p-2 font-medium">{r.label}</div>
            <div className="relative h-14 flex-1">
              {onBlock && ri < data.resources.length ? (
                <div
                  className="absolute inset-0 grid touch-none select-none"
                  style={{ gridTemplateColumns: `repeat(${COLUMNS}, minmax(0, 1fr))` }}
                >
                  {Array.from({ length: COLUMNS }, (_, col) => {
                    const picked =
                      !!sb && ri >= sb.r1 && ri <= sb.r2 && col >= sb.c1 && col <= sb.c2;
                    const here = select.cursor.row === ri && select.cursor.col === col;
                    return (
                      <div
                        key={col}
                        className={[CELL, picked && CELL_PICKED, here && CELL_CURSOR]
                          .filter(Boolean)
                          .join(' ')}
                        data-cell={`${ri}-${col}`}
                        onPointerDown={() => select.pointerDown({ row: ri, col })}
                        onPointerEnter={() => select.pointerEnter({ row: ri, col })}
                      />
                    );
                  })}
                </div>
              ) : null}
              {items
                .filter((i) => i.row === r.id)
                .map((i) => {
                  const span = spanOnDay(i.start, i.end, tz, day)!;
                  const style = {
                    ...place(span),
                    ...(i.kind === 'block' ? { backgroundImage: HATCH } : {}),
                  };
                  return (
                    <div
                      key={`${i.kind}-${i.start}-${i.text}`}
                      className={ITEM_CLASS[i.kind]}
                      style={style}
                      title={`${formatTime(i.start, tz, lang)}–${formatTime(i.end, tz, lang)} ${i.text}`}
                    >
                      {i.kind === 'shift' ? null : i.text}
                    </div>
                  );
                })}
              {now ? (
                <div
                  className="absolute inset-y-0 w-0.5 bg-danger"
                  style={{ left: pct(now.left) }}
                  aria-hidden="true"
                />
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function DayTable({
  data,
  day,
  tz,
  lang,
}: {
  data: PlanningData;
  day: string;
  tz: string;
  lang: string;
}) {
  const { t } = useTranslation('staff');
  const items = itemsOn(data, day, tz, {
    blocked: t('planning.blocked'),
    onShift: t('planning.onShift'),
  });
  const names = new Map(data.resources.map((r) => [r.id, r.label]));
  const ordered = [...items].sort(
    (a, b) =>
      (names.get(a.row) ?? '~').localeCompare(names.get(b.row) ?? '~') ||
      a.start.localeCompare(b.start),
  );
  if (ordered.length === 0) return <p>{t('planning.nothing')}</p>;
  return (
    <table className="w-full text-left">
      <caption className="sr-only">{day}</caption>
      <thead>
        <tr>
          <th scope="col" className="p-2">
            {t('planning.col.resource')}
          </th>
          <th scope="col" className="p-2">
            {t('planning.col.time')}
          </th>
          <th scope="col" className="p-2">
            {t('planning.col.item')}
          </th>
        </tr>
      </thead>
      <tbody>
        {ordered.map((i) => (
          <tr key={`${i.kind}-${i.row}-${i.start}-${i.text}`} className="border-t border-border">
            <th scope="row" className="p-2 font-normal">
              {names.get(i.row) ?? t('planning.unassigned')}
            </th>
            <td className="p-2">
              {formatTime(i.start, tz, lang)}–{formatTime(i.end, tz, lang)}
            </td>
            <td className="p-2">
              {t(`planning.kind.${i.kind}`)}: {i.text}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * `/staff/planning` (2B-A10, #285): resources as rows against the day's 15-minute columns, with
 * appointments, hatched blocks, shift backgrounds and a now line. Read-only; blocking by dragging
 * is 2B-A11. The table is the accessible equivalent of the same data.
 */
export function PlanningPage() {
  const { t, i18n } = useTranslation('staff');
  const { location } = useCurrentLocation();
  const tz = location?.tz ?? 'UTC';
  const [day, setDay] = useState(() => localDate(new Date(), tz));
  const [view, setView] = useState<View>('day');
  const [layout, setLayout] = useState<Layout>('grid');
  const [request, setRequest] = useState<BlockRequest | null>(null);
  const org = useCurrentOrg();
  const days = daysFrom(day, view === 'week' ? 7 : 1);
  const plan = usePlanning(location?.id, days[0]!, days[days.length - 1]!);
  if (!location || plan.isPending) return <Spinner label={t('planning.loading')} />;
  if (plan.isError)
    return (
      <p role="alert" className="mx-auto mt-8 max-w-3xl px-4 font-medium text-danger-strong">
        {t('planning.error')}
      </p>
    );
  const data = plan.data;

  return (
    <div className="mx-auto mt-8 flex max-w-6xl flex-col gap-4 px-4">
      <h1 className="text-2xl font-semibold">{t('planning.title')}</h1>
      <div className="flex flex-wrap items-end gap-3">
        <Button variant="secondary" onClick={() => setDay(addDays(day, view === 'week' ? -7 : -1))}>
          {t('planning.prev')}
        </Button>
        <Input
          label={t('planning.date')}
          type="date"
          value={day}
          onChange={(e) => e.target.value && setDay(e.target.value)}
        />
        <Button variant="secondary" onClick={() => setDay(addDays(day, view === 'week' ? 7 : 1))}>
          {t('planning.next')}
        </Button>
        <Button
          variant={view === 'day' ? 'primary' : 'secondary'}
          aria-pressed={view === 'day'}
          onClick={() => setView('day')}
        >
          {t('planning.day')}
        </Button>
        <Button
          variant={view === 'week' ? 'primary' : 'secondary'}
          aria-pressed={view === 'week'}
          onClick={() => setView('week')}
        >
          {t('planning.week')}
        </Button>
        <Button
          variant="secondary"
          aria-pressed={layout === 'table'}
          onClick={() => setLayout(layout === 'grid' ? 'table' : 'grid')}
        >
          {layout === 'grid' ? t('planning.showTable') : t('planning.showGrid')}
        </Button>
      </div>
      {data.resources.length === 0 ? (
        <EmptyState title={t('planning.noResources')} />
      ) : (
        days.map((d) => (
          <section key={d} aria-labelledby={`plan-${d}`}>
            <h2 id={`plan-${d}`} className="mb-2 text-lg font-semibold">
              {d}
            </h2>
            {layout === 'grid' ? (
              <DayGrid
                data={data}
                day={d}
                tz={tz}
                lang={i18n.language}
                onBlock={canManageQueues(org?.role) ? setRequest : undefined}
              />
            ) : (
              <DayTable data={data} day={d} tz={tz} lang={i18n.language} />
            )}
          </section>
        ))
      )}
      {canManageQueues(org?.role) && layout === 'grid' ? (
        <p className="text-sm text-muted">{t('planning.hint')}</p>
      ) : null}
      <BlockDialog
        request={request}
        locationId={location.id}
        tz={tz}
        onClose={() => setRequest(null)}
      />
    </div>
  );
}
