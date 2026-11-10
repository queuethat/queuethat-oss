import { errorCode } from '@qm/domain';
import { Button, Checkbox, Dialog, Input, Select } from '@qm/ui';
import { useState } from 'react';
import { useTranslation } from '../../../lib/translation.tsx';
import { useSaveEvent, type EventRow } from './api.ts';
import { instantToWall, wallToInstant } from './time.ts';

/** Creates or edits an event. Times are the location's wall clock; the database refuses moving one with bookings. */
export function EventForm({
  onClose,
  location,
  services,
  event,
}: {
  onClose: () => void;
  location: { id: string; orgId: string; tz: string };
  services: { id: string; name: string }[];
  event?: EventRow;
}) {
  const { t } = useTranslation('appointments');
  const save = useSaveEvent();
  const [title, setTitle] = useState(event?.title ?? '');
  const [serviceId, setServiceId] = useState(event?.serviceId ?? services[0]?.id ?? '');
  const [start, setStart] = useState(event ? instantToWall(event.start, location.tz) : '');
  const [end, setEnd] = useState(event ? instantToWall(event.end, location.tz) : '');
  const [capacity, setCapacity] = useState(String(event?.capacity ?? 10));
  const [isPublic, setIsPublic] = useState(event?.public ?? true);
  const [problem, setProblem] = useState<string | null>(null);
  const seats = Number(capacity);
  const valid =
    title.trim() !== '' &&
    serviceId !== '' &&
    start !== '' &&
    end > start &&
    Number.isInteger(seats) &&
    seats >= Math.max(1, event?.booked ?? 1);

  function submit() {
    if (!valid || save.isPending) return;
    setProblem(null);
    save.mutate(
      {
        id: event?.id,
        locationId: location.id,
        orgId: location.orgId,
        serviceId,
        title: title.trim(),
        start: wallToInstant(start, location.tz),
        end: wallToInstant(end, location.tz),
        capacity: seats,
        public: isPublic,
      },
      {
        onSuccess: onClose,
        onError: (error) => {
          const code = errorCode(error);
          setProblem(code === 'event_has_bookings' ? code : 'unknown');
        },
      },
    );
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={t(event ? 'events.edit' : 'events.create')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('events.close')}
          </Button>
          <Button
            disabled={!valid}
            loading={save.isPending}
            loadingLabel={t('events.save')}
            onClick={submit}
          >
            {t('events.save')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Input
          label={t('events.titleLabel')}
          maxLength={120}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <Select
          label={t('events.service')}
          value={serviceId}
          onChange={(e) => setServiceId(e.target.value)}
        >
          {services.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
        <Input
          label={t('events.starts')}
          type="datetime-local"
          value={start}
          onChange={(e) => setStart(e.target.value)}
        />
        <Input
          label={t('events.ends')}
          type="datetime-local"
          value={end}
          onChange={(e) => setEnd(e.target.value)}
        />
        <Input
          label={t('events.capacity')}
          type="number"
          min={Math.max(1, event?.booked ?? 1)}
          max={1000}
          value={capacity}
          onChange={(e) => setCapacity(e.target.value)}
        />
        <Checkbox
          label={t('events.public')}
          checked={isPublic}
          onChange={(e) => setIsPublic(e.target.checked)}
        />
        {problem ? (
          <p role="alert" className="font-medium text-danger-strong">
            {t(`events.error.${problem}` as 'events.error.unknown')}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
