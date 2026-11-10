import { cx } from './cx.ts';

export interface StepperProps {
  /** Step names, already through t(). */
  steps: readonly string[];
  /** Zero-based index of the current step. */
  current: number;
  /** Accessible name for the list, already through t(). */
  label: string;
  className?: string;
}

/**
 * Progress through a short fixed flow (wizard, booking, kiosk). Bars show the position; on narrow
 * screens only the current step's name stays visible. The current step has `aria-current="step"`.
 */
type StepState = 'done' | 'current' | 'todo';

function stateOf(i: number, current: number): StepState {
  if (i < current) return 'done';
  return i === current ? 'current' : 'todo';
}

export function Stepper({ steps, current, label, className }: StepperProps) {
  return (
    <ol aria-label={label} className={cx('flex gap-2', className)}>
      {steps.map((name, i) => {
        const state = stateOf(i, current);
        return (
          <li
            key={name}
            aria-current={state === 'current' ? 'step' : undefined}
            data-state={state}
            className="flex flex-1 flex-col gap-2 text-sm"
          >
            <span
              className={cx('h-1 rounded-full', state === 'todo' ? 'bg-border' : 'bg-primary')}
            />
            <span
              className={cx(state === 'current' ? 'font-semibold' : 'hidden text-muted sm:inline')}
            >
              {i + 1}. {name}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
