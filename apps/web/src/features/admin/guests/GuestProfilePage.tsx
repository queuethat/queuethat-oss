import {
  Badge,
  Button,
  ConfirmDestructive,
  Dialog,
  EmptyState,
  Input,
  PageHeader,
  Select,
  Skeleton,
} from '@qm/ui';
import { useQuery } from '@tanstack/react-query';
import { GuestNotes } from '../../crm/notes/GuestNotes.tsx';
import { GuestTags } from '../../crm/tags/GuestTags.tsx';
import { Link } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { useTranslation } from '../../../lib/translation.tsx';
import {
  guestQuery,
  maskContact,
  useAddGuestContact,
  useRemoveGuestContact,
  type GuestContact,
} from './api.ts';

const KNOWN_ERRORS = ['invalid_input', 'contact_in_use', 'not_found'];

function errorKey(error: Error | null) {
  if (!error) return null;
  return `errors.${KNOWN_ERRORS.includes(error.message) ? error.message : 'unknown'}` as 'errors.unknown';
}

/** One guest: contacts (masked until tapped), then visits and appointments, newest first. */
export function GuestProfilePage({ guestId }: { guestId: string }) {
  const { t, i18n } = useTranslation('admin-guests');
  const guest = useQuery(guestQuery(guestId));
  const when = (iso: string) => new Date(iso).toLocaleString(i18n.language);
  const status = (s: string) =>
    t(`status.${s in t('status', { returnObjects: true }) ? s : 'other'}` as 'status.other');

  if (guest.isPending) return <Skeleton label={t('loading')} rows={2} />;
  if (guest.isError) {
    return (
      <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-8">
        <p role="alert">{t('profile.notFound')}</p>
        <Link to="/admin/guests" className="inline-flex min-h-target items-center underline">
          {t('profile.back')}
        </Link>
      </div>
    );
  }
  const g = guest.data;
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 pb-8">
      <Link to="/admin/guests" className="inline-flex min-h-target items-center underline">
        {t('profile.back')}
      </Link>
      <PageHeader
        title={g.name || t('search.noName')}
        description={
          g.firstVisitAt
            ? t('profile.summary', {
                count: g.visitCount,
                since: new Date(g.firstVisitAt).toLocaleDateString(i18n.language),
              })
            : t('profile.noVisits')
        }
      />

      <section aria-labelledby="contacts-h" className="flex flex-col gap-3">
        <h2 id="contacts-h" className="text-xl font-semibold">
          {t('profile.contacts')}
        </h2>
        {g.contacts.length === 0 ? <p>{t('profile.noContacts')}</p> : null}
        <ul className="flex flex-col gap-2">
          {g.contacts.map((c) => (
            <ContactRow key={c.id} contact={c} name={g.name || t('search.noName')} />
          ))}
        </ul>
        <AddContact guestId={g.id} />
      </section>

      <GuestTags guestId={g.id} />
      <GuestNotes guestId={g.id} />

      <section aria-labelledby="visits-h" className="flex flex-col gap-3">
        <h2 id="visits-h" className="text-xl font-semibold">
          {t('profile.visits')}
        </h2>
        {g.visits.length === 0 ? (
          <EmptyState title={t('profile.noVisits')} />
        ) : (
          <ol className="flex flex-col gap-2">
            {g.visits.map((v) => (
              <li key={v.visitId} data-testid="guest-visit" className="flex flex-wrap gap-x-3">
                <span>{when(v.joinedAt)}</span>
                <span>{v.service ?? t('profile.service')}</span>
                <Badge>{status(v.status)}</Badge>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section aria-labelledby="appts-h" className="flex flex-col gap-3">
        <h2 id="appts-h" className="text-xl font-semibold">
          {t('profile.appointments')}
        </h2>
        {g.appointments.length === 0 ? <p>{t('profile.noAppointments')}</p> : null}
        <ol className="flex flex-col gap-2">
          {g.appointments.map((a) => (
            <li key={a.appointmentId} className="flex flex-wrap gap-x-3">
              <span>{when(a.startsAt)}</span>
              <span>{a.service ?? t('profile.service')}</span>
              <Badge>{status(a.status)}</Badge>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

function ContactRow({ contact, name }: { contact: GuestContact; name: string }) {
  const { t } = useTranslation('admin-guests');
  const [shown, setShown] = useState(false);
  const remove = useRemoveGuestContact();
  const channel = t(`contact.${contact.kind}`);
  return (
    <li data-testid="guest-contact" className="flex flex-wrap items-center gap-3">
      <span>{channel}</span>
      <span className="font-mono">
        {shown ? contact.value : maskContact(contact.kind, contact.value)}
      </span>
      {contact.verified ? <Badge>{t('contact.verified')}</Badge> : null}
      <Button
        variant="secondary"
        aria-pressed={shown}
        aria-label={t(shown ? 'contact.hideFor' : 'contact.showFor', { channel, name })}
        onClick={() => setShown((s) => !s)}
      >
        {t(shown ? 'contact.hide' : 'contact.show')}
      </Button>
      <ConfirmDestructive
        triggerLabel={t('contact.remove')}
        triggerAriaLabel={`${t('contact.remove')} ${channel}`}
        triggerVariant="secondary"
        title={t('contact.removeTitle')}
        description={t('contact.removeDescription', {
          value: maskContact(contact.kind, contact.value),
        })}
        confirmLabel={t('contact.removeConfirm')}
        cancelLabel={t('contact.cancel')}
        onConfirm={() => remove.mutateAsync(contact.id).catch(() => undefined)}
      />
    </li>
  );
}

function AddContact({ guestId }: { guestId: string }) {
  const { t } = useTranslation('admin-guests');
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<'phone' | 'email'>('phone');
  const [value, setValue] = useState('');
  const add = useAddGuestContact(guestId);
  const failure = errorKey(add.error);
  const close = () => {
    setOpen(false);
    add.reset();
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    add.mutate(
      { kind, value },
      {
        onSuccess: () => {
          setValue('');
          setOpen(false);
        },
      },
    );
  };
  return (
    <>
      <Button variant="secondary" className="self-start" onClick={() => setOpen(true)}>
        {t('add.trigger')}
      </Button>
      <Dialog open={open} onClose={close} title={t('add.title')} description={t('add.description')}>
        <form className="flex flex-col gap-4" onSubmit={submit}>
          <Select
            label={t('add.channel')}
            value={kind}
            onChange={(event) => setKind(event.target.value as 'phone' | 'email')}
          >
            <option value="phone">{t('contact.phone')}</option>
            <option value="email">{t('contact.email')}</option>
          </Select>
          <Input
            label={t('add.value')}
            required
            autoComplete="off"
            maxLength={254}
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
          <p role="alert" className="font-medium text-danger-strong empty:hidden">
            {failure ? t(failure) : null}
          </p>
          <div className="flex justify-end gap-3">
            <Button variant="secondary" onClick={close}>
              {t('add.cancel')}
            </Button>
            <Button type="submit" loading={add.isPending} loadingLabel={t('add.saving')}>
              {t('add.save')}
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
