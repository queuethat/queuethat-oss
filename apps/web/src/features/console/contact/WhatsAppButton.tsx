import { errorCode, waLink } from '@qm/domain';
import { Button } from '@qm/ui';
import { useState } from 'react';
import { useTranslation } from '../../../lib/translation.tsx';
import { useLogManualContact } from './api.ts';

/**
 * Staff message the guest from their own WhatsApp (N-4, #254). The tap is audited by the database,
 * which hands back the number only then; the message is prefilled with the ticket. An opted-out
 * number disables the button (the database decides: rule 2).
 */
export function WhatsAppButton({ visitId, ticket }: { visitId: string; ticket: string }) {
  const { t } = useTranslation('staff');
  const log = useLogManualContact();
  const [outcome, setOutcome] = useState<'optedOut' | 'noPhone' | 'failed' | null>(null);
  const open = async () => {
    // Opened first so the popup blocker sees a user gesture; pointed at the link once it is known.
    const tab = window.open('about:blank', '_blank', 'noopener');
    try {
      const phone = await log.mutateAsync(visitId);
      const link = waLink(phone, t('console.contact.whatsappText', { ticket }));
      if (!link) throw new Error('invalid_phone');
      if (tab) tab.location.href = link;
      else window.location.assign(link);
      setOutcome(null);
    } catch (error) {
      tab?.close();
      const code = errorCode(error);
      setOutcome(code === 'suppressed' ? 'optedOut' : code === 'no_contact' ? 'noPhone' : 'failed');
    }
  };
  return (
    <div className="flex flex-col gap-1">
      <Button
        variant="secondary"
        loading={log.isPending}
        disabled={outcome === 'optedOut'}
        onClick={() => void open()}
      >
        {outcome === 'optedOut' ? t('console.contact.optedOut') : t('console.contact.whatsapp')}
      </Button>
      {outcome === 'noPhone' ? <p role="status">{t('console.contact.noPhone')}</p> : null}
      {outcome === 'failed' ? <p role="alert">{t('console.contact.failed')}</p> : null}
    </div>
  );
}
