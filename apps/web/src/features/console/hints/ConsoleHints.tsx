import { Button } from '@qm/ui';
import { useTranslation } from '../../../lib/translation.tsx';
import { HINTS, useDismissedHints } from './store.ts';

/**
 * One slim line of tips the first time a console opens on this browser: Call next, the undo
 * message and the shortcut sheet. One tap on "Got it" hides them for good on this browser. They
 * sit above the lists, never cover anything and never take focus, so a busy desk can ignore them.
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
      className="flex items-center gap-3 rounded-card border border-border bg-secondary px-3 py-2 text-sm"
    >
      <p id="console-hints-text" className="min-w-0 flex-1">
        {shown.map((hint) => (
          <span key={hint}>
            <strong>{t(`${hint}.title`)}</strong> {t(`${hint}.body`)}{' '}
          </span>
        ))}
      </p>
      <Button
        variant="secondary"
        aria-describedby="console-hints-text"
        onClick={() => dismiss(HINTS)}
      >
        {t('dismiss')}
      </Button>
    </section>
  );
}
