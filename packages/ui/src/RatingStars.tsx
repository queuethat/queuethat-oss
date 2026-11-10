import { useId } from 'react';
import { cx } from './cx.ts';

export interface RatingStarsProps {
  /** Visible group label; also what a screen reader announces for the group. */
  legend: string;
  /** Accessible name of one choice, e.g. "3 of 5". */
  optionLabel: (value: number) => string;
  value: number | null;
  onChange: (value: number) => void;
  max?: number;
  disabled?: boolean;
}

/**
 * A 1..max rating as a native radio group drawn as stars, so arrow keys, Tab and screen readers
 * work without custom roles. Each star is a 48 px target; stars up to the chosen one are filled.
 */
export function RatingStars({
  legend,
  optionLabel,
  value,
  onChange,
  max = 5,
  disabled,
}: RatingStarsProps) {
  const name = useId();
  return (
    <fieldset className="flex flex-col gap-2" disabled={disabled}>
      <legend className="font-medium">{legend}</legend>
      <div className="flex gap-1">
        {Array.from({ length: max }, (_, i) => i + 1).map((n) => (
          <label
            key={n}
            className={cx(
              'relative flex size-12 cursor-pointer items-center justify-center rounded-control',
              'has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2',
              value !== null && n <= value ? 'text-warning-strong' : 'text-muted',
            )}
          >
            <input
              type="radio"
              name={name}
              value={n}
              checked={value === n}
              onChange={() => onChange(n)}
              aria-label={optionLabel(n)}
              className="absolute inset-0 size-full cursor-pointer opacity-0"
            />
            <svg aria-hidden="true" viewBox="0 0 24 24" className="size-8">
              <path
                d="M12 2.5l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.3 6.1 20.6l1.3-6.6L2.5 9.4l6.6-.8z"
                fill={value !== null && n <= value ? 'currentColor' : 'none'}
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinejoin="round"
              />
            </svg>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
