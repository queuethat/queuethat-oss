import { Button } from '@qm/ui';
import { useTranslation } from '../../../lib/translation.tsx';
import { HINTS, useDismissedHints } from './store.ts';

/**
 * Three short hints the first time a console opens on this browser: Call next, the undo message
 * and the shortcut sheet. Each can be dismissed on its own, or all at once. They sit above the
 * lists, never cover anything and never take focus, so a busy desk can ignore them.
 */
export function ConsoleHints() {
  const { t } = useTranslation('console-hints');
  const [dismissed, dismiss] = useDismissedHints();
  const shown = HINTS.filter((h) => !dismissed.includes(h));
  if (shown.length === 0) return null;
  return (
    <section
      aria-label={t('label')}
      data-testid="console-hints"
      className="flex flex-col gap-2 rounded-card border border-border bg-secondary p-3"
    >
      <ul className="flex flex-col gap-2">
        {shown.map((hint) => (
          <li key={hint} className="flex flex-wrap items-center gap-3">
            <p id={`console-hint-${hint}`} className="min-w-0 flex-1">
              <strong>{t(`${hint}.title`)}</strong> {t(`${hint}.body`)}
            </p>
            <Button
              variant="secondary"
              aria-describedby={`console-hint-${hint}`}
              onClick={() => dismiss([hint])}
            >
              {t('dismiss')}
            </Button>
          </li>
        ))}
      </ul>
      {shown.length > 1 ? (
        <div className="flex justify-end">
          <Button variant="secondary" onClick={() => dismiss(HINTS)}>
            {t('dismissAll')}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
