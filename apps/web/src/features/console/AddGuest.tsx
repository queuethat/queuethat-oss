import { errorCode } from '@qm/domain';
import { BigButton, Button, Checkbox, Dialog, Input, Select, useToast } from '@qm/ui';
import type { CountryCode, PhoneState } from '@qm/ui/phone';
import { lazy, Suspense, useState, type FormEvent } from 'react';
import { useTranslation } from '../../lib/translation.tsx';
import { useCurrentLocation } from '../auth/current.ts';
import { usePrintSettings } from '../printing/api.ts';
import { PrintSlip } from '../printing/PrintSlip.tsx';
import { isQueued } from './offline/queue.ts';
import { useSetVisitPriority, type PriorityClass } from '../admin/priority/api.ts';
import { useAddGuest, useCaptureConsent, useLocationChannels, type ConsoleQueue } from './api.ts';

const PhoneInput = lazy(() => import('@qm/ui/phone').then((m) => ({ default: m.PhoneInput })));

const NOT_ACCEPTING = ['closed', 'paused', 'outside_hours', 'full', 'org_suspended'] as const;

/** staff_add_visit's documented errors get their own copy; a closed queue says it is closed. */
export function addGuestErrorKey(
  error: unknown,
):
  | `notAccepting.${(typeof NOT_ACCEPTING)[number] | 'other'}`
  | 'capacity_reached'
  | 'invalid_input'
  | 'unknown' {
  const code = errorCode(error);
  if (code === 'queue_not_accepting') {
    const reason = (error as { details?: unknown }).details;
    return (NOT_ACCEPTING as readonly unknown[]).includes(reason)
      ? `notAccepting.${reason as (typeof NOT_ACCEPTING)[number]}`
      : 'notAccepting.other';
  }
  return code === 'capacity_reached' || code === 'invalid_input' ? code : 'unknown';
}

/**
 * Adds a walk-in to `queue` (C6, #63) in a few taps: every field but the queue is optional, and
 * the service defaults to the queue's first, as on the join page.
 */
export function AddGuest({
  queue,
  country,
  priorityClasses,
}: {
  queue: ConsoleQueue;
  country: CountryCode;
  priorityClasses?: PriorityClass[];
}) {
  const { t } = useTranslation('staff');
  const toast = useToast();
  const add = useAddGuest();
  const setPriority = useSetVisitPriority();
  const captureConsent = useCaptureConsent();
  // Unticked by default: texts need staff to say the guest agreed (3-CG4).
  const [attested, setAttested] = useState(false);
  const [priorityId, setPriorityId] = useState('');
  const { location } = useCurrentLocation();
  const printSettings = usePrintSettings(location?.id);
  const smsEnabled = useLocationChannels(location?.id).includes('sms');
  // The ticket staff chose to print from the confirmation toast.
  const [printing, setPrinting] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  // One key per guest being added, so resubmitting after a lost answer can't add them twice.
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [name, setName] = useState('');
  const [serviceId, setServiceId] = useState<string | null>(null);
  const [party, setParty] = useState('1');
  const [phone, setPhone] = useState<string | null>(null);
  // Digits that aren't a number would be saved as "no phone", so the guest would never get a
  // text while staff think they will (#549). Refuse them instead.
  const [phoneState, setPhoneState] = useState<PhoneState>('empty');
  const [phoneInvalid, setPhoneInvalid] = useState(false);
  const service = queue.services.find((s) => s.id === serviceId) ?? queue.services[0];

  function close() {
    setOpen(false);
    setName('');
    setServiceId(null);
    setParty('1');
    setPhone(null);
    setPhoneState('empty');
    setPhoneInvalid(false);
    setPriorityId('');
    setAttested(false);
    setKey(crypto.randomUUID());
    add.reset();
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (phoneState === 'invalid') {
      setPhoneInvalid(true);
      return;
    }
    add.mutate(
      {
        key,
        guest: {
          queueId: queue.id,
          serviceId: service?.id ?? null,
          name,
          partySize: Number.parseInt(party, 10) || 1,
          phoneE164: phone,
        },
      },
      {
        onSuccess: (row) => {
          // An offline-queued add has no row to prioritise yet; staff set it from the list later.
          if (priorityId && !isQueued(row) && row.id && row.version != null) {
            setPriority.mutate({ visitId: row.id, classId: priorityId, version: row.version });
          }
          if (phone && attested && smsEnabled) {
            if (isQueued(row) || !row.id) {
              toast.show({ message: t('console.addGuest.attest.offline') });
            } else {
              captureConsent.mutate(
                { visitId: row.id, key: crypto.randomUUID() },
                {
                  onError: (error) =>
                    toast.show({
                      message: t(
                        errorCode(error) === 'contact_suppressed'
                          ? 'console.addGuest.attest.optedOut'
                          : 'console.addGuest.attest.failed',
                      ),
                      tone: 'danger',
                    }),
                },
              );
            }
          }
          toast.show(
            isQueued(row)
              ? {
                  message: t('console.offline.addSaved', {
                    name: name || t('console.offline.guest'),
                  }),
                }
              : {
                  message: t('console.addGuest.added', { ticket: row.display_ticket }),
                  tone: 'success',
                  action: {
                    label: t('console.print.button'),
                    onAction: () => setPrinting(row.display_ticket ?? ''),
                  },
                },
          );
          close();
        },
      },
    );
  }

  return (
    <>
      <BigButton variant="secondary" data-shortcut="add-guest" onClick={() => setOpen(true)}>
        {t('console.addGuest.open')}
      </BigButton>
      {printing ? (
        <PrintSlip
          slip={{
            location: location?.name ?? '',
            queue: queue.name,
            ticket: printing,
            // A staff-added guest has no link token (I-7), so there is no status QR to print.
            url: null,
            tz: location?.tz ?? 'UTC',
            ...printSettings,
          }}
          onDone={() => setPrinting(null)}
        />
      ) : null}
      <Dialog
        open={open}
        onClose={() => {
          if (!add.isPending) close();
        }}
        title={t('console.addGuest.title', { queue: queue.name })}
      >
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <Input
            label={t('console.addGuest.name')}
            hint={t('console.addGuest.nameHint')}
            maxLength={60}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          {queue.services.length > 1 ? (
            <Select
              label={t('console.addGuest.service')}
              value={service?.id ?? ''}
              onChange={(e) => setServiceId(e.target.value)}
            >
              {queue.services.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          ) : null}
          {priorityClasses?.length ? (
            <Select
              label={t('console.priority.addGuest')}
              value={priorityId}
              onChange={(e) => setPriorityId(e.target.value)}
            >
              <option value="">{t('console.priority.addGuestNone')}</option>
              {priorityClasses.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          ) : null}
          <Input
            label={t('console.addGuest.party')}
            type="number"
            inputMode="numeric"
            min={1}
            max={50}
            value={party}
            onChange={(e) => setParty(e.target.value)}
          />
          <Suspense fallback={<Input label={t('console.addGuest.phone')} disabled />}>
            <PhoneInput
              label={t('console.addGuest.phone')}
              countryLabel={t('console.addGuest.country')}
              hint={t('console.addGuest.phoneHint')}
              defaultCountry={country}
              error={phoneInvalid ? t('console.addGuest.phoneInvalid') : undefined}
              onChange={setPhone}
              onStateChange={(state) => {
                setPhoneState(state);
                if (state !== 'invalid') setPhoneInvalid(false);
              }}
            />
          </Suspense>
          {phoneState === 'valid' && smsEnabled ? (
            <Checkbox
              label={t('console.addGuest.attest.v1')}
              hint={t('console.addGuest.attest.hint')}
              checked={attested}
              onChange={(e) => setAttested(e.target.checked)}
            />
          ) : null}
          {add.error ? (
            <p role="alert" className="font-medium text-danger-strong">
              {t(`console.addGuest.error.${addGuestErrorKey(add.error)}`)}
            </p>
          ) : null}
          <div className="mt-2 flex justify-between gap-8">
            <Button variant="secondary" disabled={add.isPending} onClick={close}>
              {t('console.addGuest.cancel')}
            </Button>
            <Button
              type="submit"
              loading={add.isPending}
              loadingLabel={t('console.addGuest.adding')}
            >
              {t('console.addGuest.submit')}
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
