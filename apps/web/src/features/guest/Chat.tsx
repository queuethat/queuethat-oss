import { errorCode } from '@qm/domain';
import { BigButton, Button, Input } from '@qm/ui';
import { useState } from 'react';
import { useTranslation } from '../../lib/translation.tsx';
import { useChat, type useVisitStatus } from './api.ts';

type Visit = NonNullable<ReturnType<typeof useVisitStatus>['data']>;
const MAX = 500;

/**
 * The guest's side of the chat with staff (G-15): a collapsible thread (announced politely as it
 * grows) and a box with a character count. Whether chat is on is the database's call, shown as
 * its `chat_disabled` / `rate_limited` answers.
 */
export function Chat({ token, visit }: { token: string; visit: Visit }) {
  const { t } = useTranslation('guest-chat');
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const { messages, send } = useChat(token, visit.chat_version ?? null);
  const unread = visit.unread_staff_messages ?? 0;
  const code = send.error ? errorCode(send.error) : null;
  return (
    <section className="flex flex-col gap-3" aria-labelledby="chat-title">
      <h2 id="chat-title" className="sr-only">
        {t('title')}
      </h2>
      <Button variant="secondary" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? t('close') : unread > 0 ? `${t('open')} (${unread})` : t('open')}
      </Button>
      {open ? (
        <>
          <ul aria-live="polite" className="flex max-h-64 flex-col gap-1 overflow-y-auto">
            {(messages.data ?? []).length === 0 ? <li>{t('empty')}</li> : null}
            {(messages.data ?? []).map((m) => (
              <li key={m.id} className={m.sender === 'guest' ? 'text-right' : undefined}>
                <span className="font-medium">
                  {m.sender === 'guest' ? t('you') : t('staff')}:{' '}
                </span>
                {m.body}
              </li>
            ))}
          </ul>
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const body = draft.trim();
              if (body) send.mutate(body, { onSuccess: () => setDraft('') });
            }}
          >
            <Input
              label={t('message')}
              value={draft}
              maxLength={MAX}
              hint={t('count', { count: draft.length, max: MAX })}
              onChange={(e) => setDraft(e.target.value)}
            />
            <BigButton type="submit" disabled={draft.trim() === '' || send.isPending}>
              {t('send')}
            </BigButton>
          </form>
          {send.isError ? (
            <p role="alert">
              {code === 'rate_limited'
                ? t('rateLimited')
                : code === 'chat_disabled'
                  ? t('disabled')
                  : code === 'not_found'
                    ? t('closed')
                    : t('failed')}
            </p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
