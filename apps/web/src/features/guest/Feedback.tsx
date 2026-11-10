import { errorCode } from '@qm/domain';
import { BigButton, RatingStars, Textarea } from '@qm/ui';
import { useState } from 'react';
import { useTranslation } from '../../lib/translation.tsx';
import { useSubmitFeedback } from './api.ts';

/**
 * The optional rating form on a served guest's status page (G-11): 1-5 stars and a comment, once.
 * The database decides whether feedback is open; a `not_found` answer swaps the form for a note.
 */
export function Feedback({ token }: { token: string }) {
  const { t } = useTranslation('guest-feedback');
  const [rating, setRating] = useState<number | null>(null);
  const [comment, setComment] = useState('');
  const submit = useSubmitFeedback(token);

  if (submit.isSuccess) {
    return (
      <p role="status" data-testid="feedback-thanks" className="text-center font-medium">
        {t('thanks')}
      </p>
    );
  }
  if (submit.isError && errorCode(submit.error) === 'not_found') {
    return <p role="status">{t('closed')}</p>;
  }
  return (
    <form
      aria-labelledby="feedback-title"
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (rating !== null) submit.mutate({ rating, comment });
      }}
    >
      <h2 id="feedback-title" className="text-lg font-semibold">
        {t('title')}
      </h2>
      <RatingStars
        legend={t('rating')}
        optionLabel={(value) => t('star', { value })}
        value={rating}
        onChange={setRating}
        disabled={submit.isPending}
      />
      <Textarea
        label={t('comment')}
        hint={t('commentHint')}
        maxLength={1000}
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        disabled={submit.isPending}
      />
      {submit.isError ? <p role="alert">{t('failed')}</p> : null}
      <BigButton type="submit" disabled={rating === null || submit.isPending}>
        {t('submit')}
      </BigButton>
    </form>
  );
}
