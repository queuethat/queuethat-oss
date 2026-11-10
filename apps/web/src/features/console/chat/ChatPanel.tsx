import { Button, Input } from '@qm/ui';
import { useContext, useEffect, useState } from 'react';
import { useTranslation } from '../../../lib/translation.tsx';
import { useChatMessages, useMarkChatRead, useSendStaffMessage } from './api.ts';
import { UnreadChatContext } from './Unread.tsx';

const QUICK = ['onOurWay', 'comeToDesk'] as const;
export const CHAT_MAX = 500;

/**
 * Chat with the guest in the visit sheet (G-15): the thread, two quick replies and a text box.
 * Opening the sheet marks what the guest said as read. Chat is off per queue; the database says so
 * with `chat_disabled`.
 */
export function ChatPanel({ visitId }: { visitId: string }) {
  const { t } = useTranslation('staff');
  const unread = useContext(UnreadChatContext)[visitId] ?? 0;
  const messages = useChatMessages(visitId, unread);
  const send = useSendStaffMessage(visitId);
  const markRead = useMarkChatRead(visitId);
  const [draft, setDraft] = useState('');
  const lines = messages.data ?? [];
  const lastGuest = [...lines].reverse().find((m) => m.sender === 'guest')?.id;
  const { mutate: mark } = markRead;
  useEffect(() => {
    if (unread > 0 && lastGuest !== undefined) mark(lastGuest);
  }, [unread, lastGuest, mark]);
  const post = (body: string) => {
    const text = body.trim();
    if (text) send.mutate(text, { onSuccess: () => setDraft('') });
  };
  return (
    <section className="flex flex-col gap-2" aria-labelledby={`chat-${visitId}`}>
      <h3 id={`chat-${visitId}`} className="font-medium">
        {t('console.chat.title')}
      </h3>
      <ul aria-live="polite" className="flex max-h-48 flex-col gap-1 overflow-y-auto">
        {lines.length === 0 ? <li>{t('console.chat.empty')}</li> : null}
        {lines.map((m) => (
          <li key={m.id} className={m.sender === 'staff' ? 'text-right' : undefined}>
            <span className="font-medium">{t(`console.chat.from.${m.sender}`)}: </span>
            {m.body}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        {QUICK.map((key) => (
          <Button
            key={key}
            variant="secondary"
            disabled={send.isPending}
            onClick={() => post(t(`console.chat.quick.${key}`))}
          >
            {t(`console.chat.quick.${key}`)}
          </Button>
        ))}
      </div>
      <form
        className="flex items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          post(draft);
        }}
      >
        <div className="flex-1">
          <Input
            label={t('console.chat.message')}
            value={draft}
            maxLength={CHAT_MAX}
            hint={t('console.chat.count', { count: draft.length, max: CHAT_MAX })}
            onChange={(event) => setDraft(event.target.value)}
          />
        </div>
        <Button type="submit" disabled={draft.trim() === '' || send.isPending}>
          {t('console.chat.send')}
        </Button>
      </form>
      {send.isError ? (
        <p role="alert">
          {send.error.message === 'chat_disabled'
            ? t('console.chat.disabled')
            : t('console.chat.failed')}
        </p>
      ) : null}
    </section>
  );
}
