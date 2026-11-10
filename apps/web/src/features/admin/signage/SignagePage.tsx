import { fromLocalDateTime, localDateTimeValue } from '@qm/domain';
import {
  Button,
  ConfirmDestructive,
  EmptyState,
  Input,
  PageHeader,
  Skeleton,
  Textarea,
} from '@qm/ui';
import { useQuery } from '@tanstack/react-query';
import { useState, type ChangeEvent, type FormEvent } from 'react';
import { useTranslation } from '../../../lib/translation.tsx';
import { useCurrentLocation, useCurrentOrg } from '../../auth/current.ts';
import { isAcceptedImage, reencode } from '../branding/image.ts';
import {
  signageUrl,
  slidesQuery,
  useAddSlide,
  useDeleteSlide,
  useReorderSlides,
  useUpdateSlide,
  type Slide,
  type SlideDraft,
} from './api.ts';

/** Largest side of a signage image: a TV, not a phone. */
const MAX_SIDE = 1920;
const BODY_MAX = 300;

/** An ISO instant as the `datetime-local` input wants it, on the location's wall clock (I-6). */
const toInput = (iso: string | null, tz: string) => (iso ? localDateTimeValue(iso, tz) : '');
const fromInput = (value: string, tz: string) =>
  value ? fromLocalDateTime(value, tz).toISOString() : null;

/**
 * `/admin/signage` (4-SIG1, #389): the image and text slides a location's TV rotates between calls,
 * each with a duration and an optional schedule window. Admins edit; the database decides, the
 * page mirrors it. The preview shows a slide as the TV will.
 */
export function SignagePage() {
  const { t } = useTranslation('admin');
  const org = useCurrentOrg();
  const { location } = useCurrentLocation();
  const query = useQuery({
    ...slidesQuery(location?.id ?? ''),
    enabled: !!location,
  });
  const reorder = useReorderSlides();
  if (!org || !location || !query.data) return <Skeleton label={t('signage.loading')} rows={2} />;
  const slides = query.data;
  const readOnly = org.role !== 'owner' && org.role !== 'admin';
  const move = (index: number, by: -1 | 1) => {
    const ids = slides.map((s) => s.id);
    [ids[index], ids[index + by]] = [ids[index + by]!, ids[index]!];
    reorder.mutate(ids);
  };
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 pb-8">
      <PageHeader
        title={t('signage.title')}
        description={readOnly ? t('signage.readOnly') : t('signage.intro')}
      />
      {slides.length === 0 ? <EmptyState title={t('signage.empty')} /> : null}
      <ol className="flex flex-col gap-4">
        {slides.map((slide, i) => (
          <SlideRow
            key={slide.id}
            slide={slide}
            tz={location.tz}
            readOnly={readOnly}
            onUp={i > 0 ? () => move(i, -1) : undefined}
            onDown={i < slides.length - 1 ? () => move(i, 1) : undefined}
          />
        ))}
      </ol>
      {readOnly ? null : (
        <AddSlide
          orgId={org.id}
          locationId={location.id}
          tz={location.tz}
          nextSort={(slides.at(-1)?.sort ?? 0) + 10}
        />
      )}
    </div>
  );
}

function Preview({ slide }: { slide: Slide }) {
  const { t } = useTranslation('admin');
  return (
    <div
      data-testid="slide-preview"
      className="flex min-h-24 items-center justify-center overflow-hidden rounded bg-black p-3 text-center text-white"
    >
      {slide.kind === 'image' && slide.storagePath ? (
        <img
          src={signageUrl(slide.storagePath)}
          alt={t('signage.imageAlt')}
          className="max-h-40 w-auto object-contain"
        />
      ) : (
        <p className="whitespace-pre-line text-lg">{slide.body}</p>
      )}
    </div>
  );
}

function ScheduleFields({
  draft,
  readOnly,
  tz,
  onChange,
}: {
  draft: SlideDraft;
  readOnly: boolean;
  tz: string;
  onChange: (patch: Partial<SlideDraft>) => void;
}) {
  const { t } = useTranslation('admin');
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <Input
        label={t('signage.duration')}
        type="number"
        min={3}
        max={120}
        readOnly={readOnly}
        value={draft.durationS}
        onChange={(e) => onChange({ durationS: Number(e.target.value) })}
      />
      <Input
        label={t('signage.from')}
        type="datetime-local"
        readOnly={readOnly}
        value={toInput(draft.activeFrom, tz)}
        onChange={(e) => onChange({ activeFrom: fromInput(e.target.value, tz) })}
      />
      <Input
        label={t('signage.to')}
        type="datetime-local"
        readOnly={readOnly}
        value={toInput(draft.activeTo, tz)}
        onChange={(e) => onChange({ activeTo: fromInput(e.target.value, tz) })}
      />
    </div>
  );
}

const windowOk = (d: SlideDraft) =>
  d.durationS >= 3 &&
  d.durationS <= 120 &&
  (!d.activeFrom || !d.activeTo || d.activeTo > d.activeFrom);

function SlideRow({
  slide,
  tz,
  readOnly,
  onUp,
  onDown,
}: {
  slide: Slide;
  tz: string;
  readOnly: boolean;
  onUp?: () => void;
  onDown?: () => void;
}) {
  const { t } = useTranslation('admin');
  const update = useUpdateSlide();
  const remove = useDeleteSlide();
  const [draft, setDraft] = useState<SlideDraft>({
    durationS: slide.durationS,
    activeFrom: slide.activeFrom,
    activeTo: slide.activeTo,
  });
  return (
    <li className="flex flex-col gap-3 rounded border border-current/20 p-3">
      <Preview slide={slide} />
      <ScheduleFields
        draft={draft}
        readOnly={readOnly}
        tz={tz}
        onChange={(p) => setDraft((d) => ({ ...d, ...p }))}
      />
      {update.error ? (
        <p role="alert" className="text-danger-strong font-medium">
          {t('signage.saveFailed')}
        </p>
      ) : null}
      {readOnly ? null : (
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={() => update.mutate({ id: slide.id, draft })}
            disabled={!windowOk(draft)}
            loading={update.isPending}
            loadingLabel={t('signage.saving')}
          >
            {t('signage.save')}
          </Button>
          <Button variant="secondary" onClick={onUp} disabled={!onUp}>
            {t('signage.up')}
          </Button>
          <Button variant="secondary" onClick={onDown} disabled={!onDown}>
            {t('signage.down')}
          </Button>
          <ConfirmDestructive
            triggerLabel={t('signage.remove')}
            title={t('signage.removeTitle')}
            description={t('signage.removeBody')}
            confirmLabel={t('signage.remove')}
            cancelLabel={t('signage.cancel')}
            onConfirm={() => remove.mutateAsync(slide)}
          />
        </div>
      )}
    </li>
  );
}

function AddSlide({
  orgId,
  locationId,
  tz,
  nextSort,
}: {
  orgId: string;
  locationId: string;
  tz: string;
  nextSort: number;
}) {
  const { t } = useTranslation('admin');
  const add = useAddSlide(orgId, locationId, nextSort);
  const [draft, setDraft] = useState<SlideDraft>({
    durationS: 10,
    activeFrom: null,
    activeTo: null,
    body: '',
  });
  const [error, setError] = useState<string>();

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(undefined);
    try {
      await add.mutateAsync({ draft, image: null });
      setDraft((d) => ({ ...d, body: '' }));
    } catch {
      setError(t('signage.saveFailed'));
    }
  }
  async function pick(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setError(undefined);
    if (!isAcceptedImage(file)) return setError(t('signage.imageType'));
    try {
      await add.mutateAsync({ draft, image: await reencode(file, MAX_SIDE) });
    } catch {
      setError(t('signage.imageFailed'));
    }
  }
  return (
    <form className="flex flex-col gap-4" onSubmit={(e) => void submit(e)}>
      <h2 className="text-xl font-semibold">{t('signage.add')}</h2>
      <ScheduleFields
        draft={draft}
        readOnly={false}
        tz={tz}
        onChange={(p) => setDraft((d) => ({ ...d, ...p }))}
      />
      <Textarea
        label={t('signage.text')}
        hint={t('signage.count', { count: (draft.body ?? '').length, max: BODY_MAX })}
        maxLength={BODY_MAX}
        value={draft.body}
        onChange={(e) => setDraft((d) => ({ ...d, body: e.target.value }))}
      />
      {error ? (
        <p role="alert" className="text-danger-strong font-medium">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap items-end gap-3">
        <Button
          type="submit"
          disabled={!(draft.body ?? '').trim() || !windowOk(draft)}
          loading={add.isPending}
          loadingLabel={t('signage.saving')}
        >
          {t('signage.addText')}
        </Button>
        <Input
          label={t('signage.image')}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          disabled={!windowOk(draft)}
          onChange={(e) => void pick(e)}
        />
      </div>
    </form>
  );
}
