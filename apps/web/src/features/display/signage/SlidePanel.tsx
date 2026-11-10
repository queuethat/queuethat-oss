import { useTranslation } from '../../../lib/translation.tsx';
import type { DisplaySlide } from './api.ts';
import { useSlideRotation } from './useSlideRotation.ts';

/** A ticket called a moment ago, as the panel announces it. */
export interface CallNotice {
  ticket: string;
  counter: string | null;
}

/**
 * The lower panel of the TV: the location's slides in turn, between calls. A new call takes the
 * panel over for as long as the board highlights it (the caller passes `calls`), then the
 * rotation resumes. The "now serving" board sits above and is never part of this panel.
 */
export function SlidePanel({
  slides,
  calls,
}: {
  slides: readonly DisplaySlide[];
  calls: readonly CallNotice[];
}) {
  const { t } = useTranslation('display');
  const calling = calls.length > 0;
  const index = useSlideRotation(
    slides.map((s) => s.durationS),
    calling,
  );
  if (calling) {
    return (
      <section
        data-testid="call-takeover"
        aria-label={t('signage.calling')}
        className="rounded-card bg-warning-soft px-8 py-6 text-warning-strong ring-4 ring-warning-strong"
      >
        <p className="text-3xl font-semibold">{t('signage.calling')}</p>
        <ul className="mt-2 flex flex-wrap gap-x-10 gap-y-2 text-display font-bold tabular-nums">
          {calls.map((c) => (
            <li key={c.ticket}>
              {c.ticket}
              {c.counter ? (
                <span className="ml-4 text-5xl font-normal">
                  <span aria-hidden="true">{t('board.arrow')}</span> {c.counter}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      </section>
    );
  }
  const slide = slides[index];
  if (!slide) return null;
  return (
    <section
      data-testid="slide-panel"
      aria-label={t('signage.label')}
      className="flex min-h-64 items-center justify-center overflow-hidden rounded-card border border-border bg-surface p-6 text-center"
    >
      {slide.kind === 'image' && slide.imageUrl ? (
        <img src={slide.imageUrl} alt="" className="max-h-96 w-auto object-contain" />
      ) : slide.body ? (
        <p className="whitespace-pre-line text-5xl font-semibold">{slide.body}</p>
      ) : null}
    </section>
  );
}
