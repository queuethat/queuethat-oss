import { Badge, Button, Card, EmptyState, Input, Spinner } from '@qm/ui';
import { useState } from 'react';
import { useTranslation } from '../../lib/translation.tsx';
import { useCurrentOrg } from '../auth/current.ts';
import { useDevInbox, useSendReply } from './api.ts';
import type { Thread } from './threads.ts';

/** /dev/inbox: what guests would receive by SMS, one conversation per number, with a reply box. */
export function InboxPage() {
  const { t } = useTranslation('dev-inbox');
  const org = useCurrentOrg();
  if (!org) return <Spinner label={t('loading')} />;
  return <Threads orgId={org.id} />;
}

function Threads({ orgId }: { orgId: string }) {
  const { t } = useTranslation('dev-inbox');
  const { data: threads, isPending } = useDevInbox(orgId);
  return (
    <Card className="mx-auto mt-8 flex max-w-2xl flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-muted">{t('intro')}</p>
      </div>
      {isPending ? <Spinner label={t('loading')} /> : null}
      {threads?.length === 0 ? <EmptyState title={t('empty')} /> : null}
      <ul aria-label={t('threads')} className="flex flex-col gap-6">
        {threads?.map((thread) => (
          <li key={thread.number}>
            <ThreadView orgId={orgId} thread={thread} />
          </li>
        ))}
      </ul>
    </Card>
  );
}

function ThreadView({ orgId, thread }: { orgId: string; thread: Thread }) {
  const { t } = useTranslation('dev-inbox');
  const [body, setBody] = useState('');
  const send = useSendReply(orgId);
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!body.trim()) return;
    send.mutate({ from: thread.number, body }, { onSuccess: () => setBody('') });
  };
  return (
    <section aria-label={t('thread', { number: thread.number })} className="flex flex-col gap-3">
      <h2 className="font-mono text-lg">{thread.number}</h2>
      <ol className="flex flex-col gap-2">
        {thread.messages.map((m) => (
          <li
            key={m.key}
            className={`max-w-[85%] rounded-lg px-3 py-2 ${m.direction === 'out' ? 'self-start bg-surface-raised' : 'self-end bg-info-soft'}`}
          >
            {m.direction === 'in' ? <span className="sr-only">{t('fromGuest')}: </span> : null}
            <p className="whitespace-pre-wrap">{m.body}</p>
            <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted">
              <time dateTime={m.at}>{new Date(m.at).toLocaleTimeString()}</time>
              {m.segments === null ? null : <span>{t('segments', { count: m.segments })}</span>}
              {m.status ? (
                <Badge>{t(`status.${m.status}`, { defaultValue: m.status })}</Badge>
              ) : null}
            </p>
          </li>
        ))}
      </ol>
      <form onSubmit={submit} className="flex flex-col gap-2">
        <Input
          label={t('reply', { number: thread.number })}
          hint={t('replyHint')}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          error={send.isError ? t('error', { code: send.error.message }) : undefined}
        />
        <Button type="submit" disabled={send.isPending || !body.trim()}>
          {t('send')}
        </Button>
        {send.isSuccess ? <p role="status">{t('sent', { action: send.data })}</p> : null}
      </form>
    </section>
  );
}
