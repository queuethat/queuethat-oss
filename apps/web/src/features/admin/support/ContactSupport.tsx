import { Button, Checkbox, Dialog, Input, Textarea } from '@qm/ui';
import { useState, type FormEvent } from 'react';
import { useTranslation } from '../../../lib/translation.tsx';
import { useCurrentOrg } from '../../auth/current.ts';
import { useSession } from '../../auth/api.ts';
import { supportEmail } from '../../marketing/company.ts';
import { useContactSupport } from './api.ts';

export const SUBJECT_MAX = 120;
export const MESSAGE_MAX = 4000;

const ERRORS = [
  'offline',
  'rate_limited',
  'invalid_input',
  'not_found',
  'not_authenticated',
] as const;

/**
 * "Contact support" in the staff and admin header (#1138). Opens a dialog that sends a message
 * to QueueThat support with the business, page and app version attached. Renders nothing when
 * signed out: guests and signed-out visitors never see it. Also nothing when the install has no
 * support inbox configured, so a self-hosted install never offers a form that writes to someone else.
 */
export function ContactSupportButton() {
  const { t } = useTranslation('common');
  const session = useSession();
  const [open, setOpen] = useState(false);
  if (!session.data || !supportEmail()) return null;
  return (
    <>
      <Button
        variant="secondary"
        className="shrink-0 whitespace-nowrap"
        onClick={() => setOpen(true)}
      >
        {t('contactSupport.button')}
      </Button>
      <ContactSupportDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}

/** The dialog body mounts only while open (see Dialog), so every opening starts with an empty form. */
export function ContactSupportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation('common');
  return (
    <Dialog open={open} onClose={onClose} title={t('contactSupport.title')}>
      <ContactSupportForm onClose={onClose} />
    </Dialog>
  );
}

function ContactSupportForm({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation('common');
  const org = useCurrentOrg();
  const send = useContactSupport();
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [includePage, setIncludePage] = useState(true);
  const email = supportEmail();

  const closeButton = (
    <Button variant="secondary" onClick={onClose}>
      {t('contactSupport.close')}
    </Button>
  );

  // Someone signed in who belongs to no business yet: the database has no org to file it under.
  if (!org) {
    return (
      <div className="flex flex-col gap-4">
        <p>{t('contactSupport.noOrg', { email })}</p>
        <a
          className="inline-flex min-h-target items-center font-medium underline"
          href={`mailto:${email}`}
        >
          {email}
        </a>
        <div className="flex justify-end">{closeButton}</div>
      </div>
    );
  }

  if (send.isSuccess) {
    return (
      <div className="flex flex-col gap-4" data-testid="support-sent">
        <p role="status">{t('contactSupport.sent', { reference: send.data })}</p>
        <div className="flex justify-end">{closeButton}</div>
      </div>
    );
  }

  const subjectOk = subject.trim().length > 0 && subject.trim().length <= SUBJECT_MAX;
  const messageOk = message.trim().length > 0 && message.trim().length <= MESSAGE_MAX;
  const code = send.error?.message;
  const errorKey = ERRORS.find((known) => known === code) ?? 'generic';

  const submit = (event: FormEvent) => {
    event.preventDefault();
    // One request at a time: a double tap or Enter during the send does nothing.
    if (send.isPending || !subjectOk || !messageOk) return;
    send.mutate({ orgId: org.id, subject: subject.trim(), message: message.trim(), includePage });
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
      <p className="text-muted">{t('contactSupport.intro', { org: org.name })}</p>
      <Input
        label={t('contactSupport.subject')}
        value={subject}
        maxLength={SUBJECT_MAX}
        onChange={(e) => setSubject(e.target.value)}
        autoComplete="off"
        required
      />
      <Textarea
        label={t('contactSupport.message')}
        hint={t('contactSupport.guestWarning')}
        value={message}
        maxLength={MESSAGE_MAX}
        rows={6}
        onChange={(e) => setMessage(e.target.value)}
        required
      />
      <p className="text-sm text-muted" aria-live="off">
        {t('contactSupport.count', { count: message.length, max: MESSAGE_MAX })}
      </p>
      <Checkbox
        label={t('contactSupport.includePage')}
        hint={t('contactSupport.includePageHint')}
        checked={includePage}
        onChange={(e) => setIncludePage(e.target.checked)}
      />
      {send.isError ? (
        <p role="alert" className="font-medium text-danger-strong">
          {t(`contactSupport.errors.${errorKey}`, { email })}
        </p>
      ) : null}
      <div className="flex flex-wrap justify-end gap-3">
        {closeButton}
        <Button
          type="submit"
          loading={send.isPending}
          loadingLabel={t('contactSupport.sending')}
          disabled={!subjectOk || !messageOk}
        >
          {t('contactSupport.send')}
        </Button>
      </div>
    </form>
  );
}
