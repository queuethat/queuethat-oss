import { Card, LinkButton } from '@qm/ui';
import { useTranslation } from '../../lib/translation.tsx';

/**
 * What the embeddable widget shows once a guest has joined (J7): the frame is on another site, so
 * it never navigates; the guest's place opens in a new tab, with no referrer to the host page.
 */
export default function WidgetDone({ token }: { token: string }) {
  const { t } = useTranslation('guest');
  return (
    <Card className="flex flex-col gap-3">
      <h1 className="text-xl font-semibold">{t('join.widget.inLineTitle')}</h1>
      <p>{t('join.widget.inLineBody')}</p>
      <LinkButton
        href={`/v/${encodeURIComponent(token)}`}
        target="_blank"
        rel="noopener noreferrer"
      >
        {t('join.widget.inLineLink')}
      </LinkButton>
    </Card>
  );
}
