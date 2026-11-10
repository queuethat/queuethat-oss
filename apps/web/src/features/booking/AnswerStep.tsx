import { BigButton, Button } from '@qm/ui';
import { errorCode } from '@qm/domain';
import { useEffect, useState } from 'react';
import { useTranslation } from '../../lib/translation.tsx';
import { useJoinForm, useSetBookingAnswers, type Answers } from '../guest/api.ts';
import { FormFields } from '../guest/FormFields.tsx';
import { draftFrom, focusAnswer, formAnswers, type FormDraft } from '../guest/formFields.ts';
import { RpcError } from '../guest/rpcError.ts';

/**
 * Shown when the booking exists but the database refused its answers (a required one is missing, or
 * one is not acceptable). The booking is already made, so the guest can fix them here, or carry on
 * to their appointment page, where the link they need to cancel or change the time lives.
 */
export function AnswerStep({
  token,
  queueId,
  serviceId,
  initial,
  initialError,
  onDone,
}: {
  token: string;
  queueId: string | null;
  serviceId: string;
  /** What the guest had typed, so a refusal does not cost them their work. */
  initial: Answers;
  /** The error that brought the guest here. */
  initialError: unknown;
  onDone: () => void;
}) {
  const { t } = useTranslation('guest-intake');
  const form = useJoinForm(queueId, serviceId, 'booking');
  const save = useSetBookingAnswers();
  const fields = form.data ?? [];
  const [edits, setEdits] = useState<FormDraft>({});
  const draft = { ...draftFrom(fields, initial), ...edits };
  const error = save.error ?? initialError;
  // The database names the failing field in DETAIL; anything else is a connection problem.
  const refused =
    error instanceof RpcError && errorCode(error) === 'invalid_answers' ? error.details : null;
  useEffect(() => {
    if (refused) focusAnswer(refused);
  }, [refused]);

  return (
    <form
      className="flex flex-col gap-5 py-4"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate({ token, answers: formAnswers(fields, draft) }, { onSuccess: onDone });
      }}
    >
      <header>
        <h1 className="text-3xl font-bold">{t('booked.title')}</h1>
        <p className="text-lg text-muted">{t('booked.body')}</p>
      </header>
      <FormFields
        fields={fields}
        draft={draft}
        errors={refused ? { [refused]: t('invalid') } : {}}
        onChange={(key, value) => setEdits({ ...edits, [key]: value })}
      />
      {error && !refused ? (
        <p role="alert" className="font-medium text-danger-strong">
          {t('booked.failed')}
        </p>
      ) : null}
      <BigButton type="submit" loading={save.isPending} loadingLabel={t('booked.saving')}>
        {t('booked.save')}
      </BigButton>
      <Button variant="secondary" onClick={onDone}>
        {t('booked.skip')}
      </Button>
    </form>
  );
}
