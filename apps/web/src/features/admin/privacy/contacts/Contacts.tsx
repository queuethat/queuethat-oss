import { Button, Checkbox, Input, Select, Skeleton, useToast } from '@qm/ui';
import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from '../../../../lib/translation.tsx';
import {
  JURISDICTIONS,
  REPORTING_LINKS,
  privacyContactQuery,
  useSavePrivacyContact,
  type Jurisdiction,
  type PrivacyContact,
} from './api.ts';

const EMPTY: PrivacyContact = {
  officerName: '',
  email: '',
  phone: '',
  jurisdiction: 'ca',
  showPhone: false,
};

/**
 * The business's privacy officer and breach contact. Required before a sensitive form field or
 * text messages can go live (the database enforces it); guests see the name and email in the
 * privacy notice. Reporting links are information, not advice.
 */
export function Contacts({ orgId, canEdit }: { orgId: string; canEdit: boolean }) {
  const { t } = useTranslation('admin-privacy');
  const current = useQuery(privacyContactQuery(orgId));
  if (current.isPending) return <Skeleton label={t('loading')} rows={3} />;
  if (current.isError) return <p role="alert">{t('privacy.failed')}</p>;
  return <ContactForm orgId={orgId} canEdit={canEdit} saved={current.data} />;
}

function ContactForm({
  orgId,
  canEdit,
  saved,
}: {
  orgId: string;
  canEdit: boolean;
  saved: PrivacyContact | null;
}) {
  const { t } = useTranslation('admin-privacy');
  const toast = useToast();
  const save = useSavePrivacyContact(orgId);
  const [draft, setDraft] = useState<PrivacyContact>(saved ?? EMPTY);
  const set = <K extends keyof PrivacyContact>(key: K, value: PrivacyContact[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));
  const filled = draft.officerName.trim() !== '' && /^\S+@\S+\.\S+$/.test(draft.email.trim());
  const links = REPORTING_LINKS[draft.jurisdiction];
  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate(draft, { onSuccess: () => toast.show({ message: t('privacy.contacts.saved') }) });
  };
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={submit}
      aria-labelledby="contacts-h"
      data-testid="privacy-contacts"
    >
      <h2 id="contacts-h" className="text-xl font-semibold">
        {t('privacy.contacts.title')}
      </h2>
      <p>{t('privacy.contacts.explain')}</p>
      {saved ? null : (
        <p data-testid="contacts-missing" className="font-medium">
          {t('privacy.contacts.missing')}
        </p>
      )}
      <Input
        label={t('privacy.contacts.name')}
        value={draft.officerName}
        maxLength={120}
        readOnly={!canEdit}
        onChange={(e) => set('officerName', e.target.value)}
      />
      <Input
        label={t('privacy.contacts.email')}
        type="email"
        value={draft.email}
        maxLength={254}
        readOnly={!canEdit}
        onChange={(e) => set('email', e.target.value)}
      />
      <Input
        label={t('privacy.contacts.phone')}
        hint={t('privacy.contacts.phoneHint')}
        type="tel"
        value={draft.phone}
        maxLength={40}
        readOnly={!canEdit}
        onChange={(e) => set('phone', e.target.value)}
      />
      <Select
        label={t('privacy.contacts.jurisdiction')}
        value={draft.jurisdiction}
        disabled={!canEdit}
        onChange={(e) => set('jurisdiction', e.target.value as Jurisdiction)}
      >
        {JURISDICTIONS.map((j) => (
          <option key={j} value={j}>
            {t(`privacy.contacts.j.${j}`)}
          </option>
        ))}
      </Select>
      <section aria-labelledby="reporting-h" className="flex flex-col gap-1">
        <h3 id="reporting-h" className="font-semibold">
          {t('privacy.contacts.reporting')}
        </h3>
        <p className="text-muted">{t('privacy.contacts.notAdvice')}</p>
        {links.length ? (
          <ul>
            {links.map((l) => (
              <li key={l.key}>
                <a
                  href={l.href}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex min-h-target items-center underline"
                >
                  {t(`privacy.contacts.link.${l.key}`)}
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted">{t('privacy.contacts.noLinks')}</p>
        )}
      </section>
      <Checkbox
        label={t('privacy.contacts.showPhone')}
        checked={draft.showPhone}
        disabled={!canEdit}
        onChange={(e) => set('showPhone', e.target.checked)}
      />
      <p className="text-muted">{t('privacy.contacts.guestNotice')}</p>
      {canEdit ? (
        <Button type="submit" className="self-start" disabled={!filled} loading={save.isPending}>
          {t('privacy.contacts.save')}
        </Button>
      ) : (
        <p className="text-muted">{t('privacy.contacts.readOnly')}</p>
      )}
      <p role="alert" className="font-medium text-danger-strong empty:hidden">
        {save.isError ? t('privacy.contacts.error') : null}
      </p>
    </form>
  );
}
