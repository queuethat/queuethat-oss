import { cx } from './cx.ts';
import type { IconDef } from './icons.ts';

export type IconSize = 'sm' | 'md' | 'lg';

const SIZE: Record<IconSize, string> = { sm: 'size-4', md: 'size-5', lg: 'size-6' };

export interface IconProps {
  /** An icon constant from `@qm/ui` (for example `iconCheck`). */
  icon: IconDef;
  /**
   * Accessible name, already through t(). Omit when the icon sits next to text or inside a
   * labelled control: it is then hidden from assistive tech. Pass it only when the icon stands alone.
   */
  label?: string;
  size?: IconSize;
  className?: string;
}

/** Inline SVG icon in `currentColor`. Decorative (`aria-hidden`) unless `label` is given. */
export function Icon({ icon, label, size = 'md', className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      focusable="false"
      className={cx('shrink-0', SIZE[size], className)}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <path d={icon} />
    </svg>
  );
}
