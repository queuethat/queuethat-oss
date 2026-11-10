import { PageHeader } from '@qm/ui';
import { useTranslation } from '../../../lib/translation.tsx';
import { HelpArticles } from './HelpArticles.tsx';

/** `/admin/help`: the self-serve help articles, for every member. */
export function HelpPage() {
  const { t } = useTranslation('admin-support');
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 pb-8">
      <PageHeader title={t('help.page')} />
      <HelpArticles />
    </div>
  );
}
