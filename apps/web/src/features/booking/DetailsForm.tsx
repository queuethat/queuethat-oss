import { BigButton, Button, Card, Input } from '@qm/ui';
import { PhoneInput, type CountryCode, type PhoneState } from '@qm/ui/phone';
import { useState, type FormEvent, type ReactNode } from 'react';
import { useTranslation } from '../../lib/translation.tsx';
import { useJoinForm, type Answers } from '../guest/api.ts';
import { FormFields } from '../guest/FormFields.tsx';
import { formAnswers, type FormDraft } from '../guest/formFields.ts';

export interface Details {
  name: string;
  phoneE164: string | null;
  email: string | null;
  /**
   * What the guest answered on the service's form, sent right after booking. Null when the form is
   * known to be empty, so nothing is sent; an object (even empty) when it has questions or could
   * not be read, so the database still checks the required ones.
   */
  answers: Answers | null;
}

/** The last booking step: who is coming, how to reach them, and Confirm. Loaded once a time is picked. */
export function DetailsForm({
  summary,
  queueId = null,
  serviceId,
  countryCode,
  retentionDays,
  problem,
  pending,
  onBack,
  onSubmit,
  extra,
  contactRequired = false,
  emailRequired = false,
}: {
  summary: string;
  /** Appointments only: the service's queue and the service, whose form is asked after the contact fields. */
  queueId?: string | null;
  serviceId?: string;
  countryCode: string | null;
  /** How long the business keeps contact details; shown in the privacy note. */
  retentionDays: number | null;
  problem: string | null;
  pending: boolean;
  onBack: () => void;
  onSubmit: (details: Details) => void;
  /** Fields a flow adds above the privacy note (an event's party size). */
  extra?: ReactNode;
  /** Some flows (events) need a phone or an email to reach the guest. */
  contactRequired?: boolean;
  /** The waitlist offers a slot by email, so it needs one. */
  emailRequired?: boolean;
}) {
  const { t, i18n } = useTranslation('booking');
  const [name, setName] = useState('');
  const [nameMissing, setNameMissing] = useState(false);
  const [phone, setPhone] = useState<string | null>(null);
  // Digits that aren't a number would book with no phone, so the guest would wait for a text
  // that never comes. Refuse them; an empty phone stays fine.
  const [phoneState, setPhoneState] = useState<PhoneState>('empty');
  const [phoneInvalid, setPhoneInvalid] = useState(false);
  const [email, setEmail] = useState('');
  const [contactMissing, setContactMissing] = useState(false);
  // The service's own questions, as the database publishes them for bookings. Whether an answer is
  // acceptable is for set_booking_answers to say, right after the booking.
  const form = useJoinForm(queueId, serviceId ?? null, 'booking');
  const fields = form.data ?? [];
  const formLoading = queueId !== null && form.isPending;
  const [draft, setDraft] = useState<FormDraft>({});

  function submit(event: FormEvent) {
    event.preventDefault();
    const missing = name.trim() === '';
    const badPhone = phoneState === 'invalid';
    const noContact =
      (contactRequired && phone === null && email.trim() === '') ||
      (emailRequired && email.trim() === '');
    if (missing || badPhone || noContact) {
      setNameMissing(missing);
      setPhoneInvalid(badPhone);
      setContactMissing(noContact);
      return;
    }
    onSubmit({
      name: name.trim(),
      phoneE164: phone,
      email: email.trim() || null,
      answers:
        queueId === null || (form.isSuccess && fields.length === 0)
          ? null
          : formAnswers(fields, draft),
    });
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-5" noValidate>
      <Card role="status" className="flex flex-col gap-1">
        <p className="font-semibold">{summary}</p>
        <Button variant="secondary" onClick={onBack}>
          {t('book.back')}
        </Button>
      </Card>
      <Input
        label={t('book.name')}
        autoComplete="given-name"
        maxLength={50}
        required
        value={name}
        error={nameMissing ? t('book.nameMissing') : undefined}
        onChange={(e) => {
          setName(e.target.value);
          setNameMissing(false);
        }}
      />
      <PhoneInput
        label={t('book.phone')}
        countryLabel={t('book.country')}
        hint={t('book.phoneHint')}
        defaultCountry={(countryCode as CountryCode | null) ?? 'US'}
        error={phoneInvalid ? t('book.phoneInvalid') : undefined}
        onChange={setPhone}
        onStateChange={(state) => {
          setPhoneState(state);
          if (state !== 'invalid') setPhoneInvalid(false);
        }}
        locale={i18n.language}
      />
      <Input
        label={t('book.email')}
        hint={t('book.emailHint')}
        type="email"
        inputMode="email"
        autoComplete="email"
        maxLength={254}
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
      {contactMissing ? (
        <p role="alert" className="font-medium text-danger-strong">
          {t(emailRequired ? 'waitlist.emailRequired' : 'book.contactRequired')}
        </p>
      ) : null}
      {fields.length > 0 ? (
        <FormFields
          fields={fields}
          draft={draft}
          errors={{}}
          onChange={(key, value) => setDraft({ ...draft, [key]: value })}
        />
      ) : null}
      {extra}
      <details className="text-sm text-muted">
        <summary className="min-h-target cursor-pointer py-3 font-medium text-fg">
          {t('book.privacy.summary')}
        </summary>
        <p>{t('book.privacy.body')}</p>
        {retentionDays ? (
          <p data-testid="retention-notice">
            {t('book.privacy.retention', { count: retentionDays })}
          </p>
        ) : null}
      </details>
      {problem ? (
        <p role="alert" className="font-medium text-danger-strong">
          {t(`book.error.${problem}` as 'book.error.unknown')}
        </p>
      ) : null}
      <BigButton
        type="submit"
        loading={pending}
        disabled={formLoading}
        loadingLabel={t('book.submitting')}
      >
        {t('book.submit')}
      </BigButton>
    </form>
  );
}
