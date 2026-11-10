import type { Key, ReactNode } from 'react';
import { cx } from './cx.ts';
import { ScrollRegion } from './ScrollRegion.tsx';

export interface DataColumn<Row> {
  /** Stable id, also the React key of the column. */
  id: string;
  /** Column heading, already through t(). Below 640px it becomes the label beside each value. */
  header: string;
  /** Renders the cell. Interactive content (buttons, links) must come from `@qm/ui`. */
  cell: (row: Row) => ReactNode;
  align?: 'start' | 'end';
  /** Extra classes for the cell, for example a width. */
  className?: string;
}

export interface DataTableProps<Row> {
  /** Names the table for assistive tech, already through t(). */
  label: string;
  columns: readonly DataColumn<Row>[];
  rows: readonly Row[];
  getRowKey: (row: Row) => Key;
  /** Shown instead of the table when `rows` is empty, usually an `EmptyState`. */
  empty?: ReactNode;
  /**
   * Wrap the table in a focusable `ScrollRegion` with this name (through t()) when it can be wider
   * than its container. Leave it out when the columns always fit.
   */
  scrollLabel?: string;
  className?: string;
}

/**
 * A table on screens of 640px and up, a stack of labelled cards below. One DOM for both: the
 * table roles are explicit so they survive the card layout, and the header row stays in the
 * accessibility tree (visually hidden) while each card cell shows its column heading.
 */
export function DataTable<Row>({
  label,
  columns,
  rows,
  getRowKey,
  empty,
  scrollLabel,
  className,
}: DataTableProps<Row>) {
  if (rows.length === 0 && empty) return <>{empty}</>;
  const table = (
    <table
      role="table"
      aria-label={label}
      className={cx('w-full border-collapse text-start max-sm:block', className)}
    >
      {/* Explicit roles keep table semantics when CSS turns the table into cards. */}
      {/* eslint-disable-next-line jsx-a11y/no-redundant-roles */}
      <thead role="rowgroup" className="max-sm:sr-only">
        <tr role="row">
          {columns.map((c) => (
            <th
              key={c.id}
              role="columnheader"
              scope="col"
              className={cx(
                'border-b border-border px-3 py-2 text-sm font-semibold text-muted',
                c.align === 'end' ? 'text-end' : 'text-start',
              )}
            >
              {c.header}
            </th>
          ))}
        </tr>
      </thead>
      {/* eslint-disable-next-line jsx-a11y/no-redundant-roles */}
      <tbody role="rowgroup" className="max-sm:flex max-sm:flex-col max-sm:gap-2">
        {rows.map((row) => (
          <tr
            key={getRowKey(row)}
            role="row"
            className="max-sm:block max-sm:rounded-card max-sm:border max-sm:border-border max-sm:bg-surface max-sm:p-3"
          >
            {columns.map((c) => (
              <td
                key={c.id}
                // eslint-disable-next-line jsx-a11y/no-interactive-element-to-noninteractive-role
                role="cell"
                data-label={c.header}
                className={cx(
                  'sm:border-b sm:border-border sm:px-3 sm:py-3',
                  'max-sm:flex max-sm:items-baseline max-sm:justify-between max-sm:gap-4 max-sm:py-1',
                  'max-sm:before:text-sm max-sm:before:text-muted max-sm:before:content-[attr(data-label)]',
                  c.align === 'end' ? 'text-end' : 'text-start',
                  c.className,
                )}
              >
                {c.cell(row)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
  return scrollLabel ? <ScrollRegion label={scrollLabel}>{table}</ScrollRegion> : table;
}
