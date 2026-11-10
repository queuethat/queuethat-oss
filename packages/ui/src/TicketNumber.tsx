import type { HTMLAttributes } from 'react';
import { cx } from './cx.ts';

export type TicketNumberSize = 'phone' | 'tablet' | 'tv' | 'board' | 'counter' | 'print';

const SIZE: Record<TicketNumberSize, string> = {
  phone: 'text-2xl',
  tablet: 'text-3xl',
  tv: 'text-display',
  // 64px on a small screen, 96px from 1536px wide (a 1920 TV): the board's tickets.
  board: 'text-display 2xl:text-board',
  counter: 'text-counter',
  // Takes the size of its container (the printed slip sets 40pt for its paper width), always black.
  print: 'text-[1em] leading-none text-black',
};

export interface TicketNumberProps extends HTMLAttributes<HTMLSpanElement> {
  /** The ticket exactly as the database returned it (for example "A007"). Never recomposed here. */
  ticket: string;
  size?: TicketNumberSize;
}

/** A ticket number in the mono face with tabular figures, so digits line up and never jitter. */
export function TicketNumber({ ticket, size = 'phone', className, ...rest }: TicketNumberProps) {
  return (
    <span
      className={cx('font-mono font-bold tabular-nums tracking-tight', SIZE[size], className)}
      {...rest}
    >
      {ticket}
    </span>
  );
}
