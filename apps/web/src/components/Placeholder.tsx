import { useTranslation } from '../lib/translation.tsx';

/** Temporary stand-in for a screen that a later ticket builds. `title` is already translated. */
export function Placeholder({ title, ticket }: { title: string; ticket: string }) {
  const { t } = useTranslation();
  return (
    <section data-testid="placeholder">
      <h1>{title}</h1>
      <p>{t('placeholder.builtIn', { ticket })}</p>
    </section>
  );
}
