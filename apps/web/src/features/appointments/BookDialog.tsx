import { errorCode } from '@qm/domain';
import { Button, Checkbox, Dialog, Input, Select, Spinner, useToast } from '@qm/ui';
import { useState } from 'react';
import { useTranslation } from '../../lib/translation.tsx';
import { uuid } from '../guest/api.ts';
import { useServiceSlots } from '../booking/api.ts';
import { SlotPicker } from '../booking/SlotPicker.tsx';
import { formatWhen, localDate } from '../booking/slots.ts';
import { useCreateSeries, useStaffBook, type SeriesResult } from './api.ts';
import { NO_REPEAT, RepeatFields, repeatReady, type RepeatState } from './RepeatFields.tsx';
import { SeriesPreview } from './SeriesPreview.tsx';

/** "10:00" on the wall clock of `tz`: the series is stored as a local time, so it stays put across DST. */
function localTime(instant: string, tz: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(instant));
}

/**
 * Books a slot for a caller at the desk. Slots come from the same public listing guests use, so
 * the two can never disagree; the capacity override is offered to managers only and the database
 * refuses it for anyone else.
 */
export function BookDialog({
  open,
  onClose,
  location,
  services,
  canOverride,
}: {
  open: boolean;
  onClose: () => void;
  location: { id: string; slug: string; tz: string };
  services: { id: string; name: string }[];
  canOverride: boolean;
}) {
  const { t, i18n } = useTranslation('appointments');
  const book = useStaffBook();
  const series = useCreateSeries();
  const toast = useToast();
  const [repeat, setRepeat] = useState<RepeatState>(NO_REPEAT);
  const [preview, setPreview] = useState<SeriesResult | null>(null);
  const [serviceId, setServiceId] = useState(services[0]?.id ?? '');
  const [slot, setSlot] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [override, setOverride] = useState(false);
  // One key per attempt: a double tap or a retry after a lost answer is the same booking.
  const [key, setKey] = useState(uuid);
  const availability = useServiceSlots(location.slug, serviceId ? [serviceId] : [], location.tz);
  const slots = availability.slots[serviceId] ?? [];
  const failure = (book.error ?? series.error) ? errorCode(book.error ?? series.error) : null;
  const repeating = repeat.repeat;
  const pending = book.isPending || series.isPending;

  function reset() {
    setSlot(null);
    setName('');
    setPhone('');
    setEmail('');
    setOverride(false);
    setRepeat(NO_REPEAT);
    setPreview(null);
    setKey(uuid());
  }

  /** A series is previewed first (nothing is kept), then booked on the second tap with the same key. */
  function submitSeries(dryRun: boolean) {
    if (!slot || !name.trim() || pending) return;
    series.mutate(
      {
        key,
        dryRun,
        locationId: location.id,
        serviceId,
        name: name.trim(),
        phoneE164: phone.trim() || null,
        email: email.trim() || null,
        firstDate: localDate(slot, location.tz),
        localTime: localTime(slot, location.tz),
        intervalWeeks: repeat.intervalWeeks,
        count: repeat.endsBy === 'count' ? repeat.count : null,
        until: repeat.endsBy === 'until' ? repeat.until : null,
      },
      {
        onSuccess: (result) => {
          if (dryRun) return setPreview(result);
          toast.show({ message: t('repeat.doneToast', { count: result.booked.length, name }) });
          reset();
          onClose();
        },
      },
    );
  }

  function submit() {
    if (repeating) return submitSeries(preview === null);
    if (!slot || !name.trim() || book.isPending) return;
    book.mutate(
      {
        key,
        locationId: location.id,
        serviceId,
        slotStart: slot,
        name: name.trim(),
        phoneE164: phone.trim() || null,
        email: email.trim() || null,
        overrideCapacity: canOverride && override,
      },
      {
        onSuccess: () => {
          reset();
          onClose();
        },
        onError: (error) => {
          if (['slot_full', 'slot_unavailable'].includes(errorCode(error))) {
            setSlot(null);
            setKey(uuid());
            void availability.refresh();
          }
        },
      },
    );
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('book.title')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('book.close')}
          </Button>
          {preview ? (
            <Button variant="secondary" onClick={() => setPreview(null)}>
              {t('repeat.back')}
            </Button>
          ) : null}
          <Button
            disabled={!slot || !name.trim() || !repeatReady(repeat) || preview?.booked.length === 0}
            loading={pending}
            loadingLabel={t('book.submit')}
            onClick={submit}
          >
            {preview
              ? t('repeat.confirm', { count: preview.booked.length })
              : repeating
                ? t('repeat.review')
                : t('book.submit')}
          </Button>
        </>
      }
    >
      {preview && slot ? (
        <SeriesPreview preview={preview} time={localTime(slot, location.tz)} />
      ) : (
        <div className="flex flex-col gap-4">
          <Select
            label={t('book.service')}
            value={serviceId}
            onChange={(e) => {
              setServiceId(e.target.value);
              setSlot(null);
            }}
          >
            {services.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
          {slot ? (
            <div className="flex items-center justify-between gap-3">
              <p className="font-semibold">
                {t('book.chosen', { when: formatWhen(slot, location.tz, i18n.language) })}
              </p>
              <Button variant="secondary" onClick={() => setSlot(null)}>
                {t('book.change')}
              </Button>
            </div>
          ) : availability.isPending ? (
            <Spinner label={t('agenda.loading')} />
          ) : slots.length === 0 ? (
            <p role="status">{t('book.noSlots')}</p>
          ) : (
            <SlotPicker slots={slots} tz={location.tz} onPick={setSlot} />
          )}
          <Input
            label={t('book.name')}
            maxLength={50}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Input
            label={t('book.phone')}
            inputMode="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
          <Input
            label={t('book.email')}
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <RepeatFields value={repeat} onChange={setRepeat} />
          {canOverride && !repeating ? (
            <Checkbox
              label={t('book.override')}
              hint={t('book.overrideHint')}
              checked={override}
              onChange={(e) => setOverride(e.target.checked)}
            />
          ) : null}
          {failure ? (
            <p role="alert" className="font-medium text-danger-strong">
              {t(`book.error.${failure}` as 'book.error.unknown', {
                defaultValue: t('book.error.unknown'),
              })}
            </p>
          ) : null}
        </div>
      )}
      {preview && failure ? <p role="alert">{t('book.error.unknown')}</p> : null}
    </Dialog>
  );
}
