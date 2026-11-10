import { cx } from './cx.ts';

export interface BarChartProps {
  /** What the chart shows, e.g. "Joins per day, last 30 days". Announced as the image name. */
  label: string;
  /** One bar per entry, in order. `label` names the bar in its tooltip, e.g. "25 Oct: 12". */
  bars: { key: string; label: string; value: number }[];
  className?: string;
}

/**
 * Column chart for counts over time. It is a picture only: screen readers get `label`, so the
 * page shows the same numbers in a table next to it.
 */
export function BarChart({ label, bars, className }: BarChartProps) {
  const max = Math.max(1, ...bars.map((b) => b.value));
  const width = Math.max(1, bars.length) * 10;
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${width} 100`}
      preserveAspectRatio="none"
      className={cx('h-40 w-full text-primary', className)}
    >
      {bars.map((bar, i) => {
        const height = (bar.value / max) * 100;
        return (
          <rect
            key={bar.key}
            x={i * 10 + 1}
            y={100 - height}
            width={8}
            height={height}
            className="fill-current"
          >
            <title>{bar.label}</title>
          </rect>
        );
      })}
    </svg>
  );
}
