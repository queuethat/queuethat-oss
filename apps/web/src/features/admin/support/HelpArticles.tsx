import { useTranslation } from '../../../lib/translation.tsx';

/** Article ids, in reading order. Each has `help.articles.<id>.{title,body[]}` in `admin-support`. */
export const HELP_ARTICLE_IDS = [
  'line',
  'callNext',
  'qr',
  'sms',
  'staff',
  'hours',
  'data',
] as const;

/** Anchor of the help section, used by the header Help link. */
export const HELP_ANCHOR = 'help';

/**
 * Short self-serve answers shown on the Support page. A contents list links to each article by
 * anchor; the text lives in the lazy `admin-support` namespace so no route or guest bytes are added.
 */
export function HelpArticles() {
  const { t } = useTranslation('admin-support');
  return (
    <section className="flex flex-col gap-4" aria-labelledby="help-title" id={HELP_ANCHOR}>
      <h2 id="help-title" className="text-xl font-semibold">
        {t('help.title')}
      </h2>
      <p>{t('help.intro')}</p>
      <nav aria-label={t('help.contents')}>
        <ul className="flex flex-col">
          {HELP_ARTICLE_IDS.map((id) => (
            <li key={id}>
              <a
                href={`#help-${id}`}
                className="inline-flex min-h-target items-center font-medium underline"
              >
                {t(`help.articles.${id}.title`)}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      {HELP_ARTICLE_IDS.map((id) => (
        <article
          key={id}
          id={`help-${id}`}
          aria-labelledby={`help-${id}-title`}
          className="scroll-mt-4"
        >
          <h3 id={`help-${id}-title`} className="text-lg font-semibold">
            {t(`help.articles.${id}.title`)}
          </h3>
          <ul className="mt-2 flex list-disc flex-col gap-1 pl-6">
            {(t(`help.articles.${id}.body`, { returnObjects: true }) as string[]).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </article>
      ))}
    </section>
  );
}
