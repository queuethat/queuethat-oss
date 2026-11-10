import { smsSegments } from '@qm/domain';
import { Badge, Button, Dialog, Textarea, useToast } from '@qm/ui';
import { useRef, useState } from 'react';
import { useTranslation } from '../../../lib/translation.tsx';
import { useCurrentOrg } from '../../auth/current.ts';
import type { ConsoleQueue } from '../api.ts';
import { useBroadcasts, useSendQueueMessage } from './api.ts';

const MANAGER_ROLES = ['manager', 'admin', 'owner'];
const KNOWN_ERRORS = ['rate_limited', 'unknown_variable', 'invalid_input', 'org_suspended'];

/**
 * N-15 (#181): "Message everyone". Managers and above compose, review and send one text to every
 * guest waiting or called in the queue; staff don't see it (the database refuses them anyway).
 * `reachable` is the number of waiting and called guests, an upper bound the server narrows.
 */
export function Broadcast({ queue, reachable }: { queue: ConsoleQueue; reachable: number }) {
  const { t } = useTranslation('staff');
  const role = useCurrentOrg()?.role;
  const allowed = !!role && MANAGER_ROLES.includes(role);
  const history = useBroadcasts(queue.id, allowed);
  const [open, setOpen] = useState(false);
  if (!allowed) return null;
  return (
    <div className="mb-4 flex flex-col gap-2" data-testid="broadcast">
      <div>
        <Button variant="secondary" onClick={() => setOpen(true)}>
          {t('console.broadcast.open')}
        </Button>
      </div>
      {open ? (
        <Composer queue={queue} reachable={reachable} onClose={() => setOpen(false)} />
      ) : null}
      <section aria-label={t('console.broadcast.history')}>
        <h2 className="font-semibold">{t('console.broadcast.history')}</h2>
        {history.data?.length === 0 ? (
          <p className="text-muted">{t('console.broadcast.historyEmpty')}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {history.data?.map((b) => (
              <li key={b.id}>
                <span>{b.body}</span>{' '}
                <span className="text-muted">
                  {t('console.broadcast.historyItem', {
                    recipients: b.recipients,
                    suppressed: b.suppressed,
                  })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Composer({
  queue,
  reachable,
  onClose,
}: {
  queue: ConsoleQueue;
  reachable: number;
  onClose: () => void;
}) {
  const { t } = useTranslation('staff');
  const toast = useToast();
  const send = useSendQueueMessage(queue.id);
  const [body, setBody] = useState('');
  const [confirming, setConfirming] = useState(false);
  // One key per opened dialog: pressing Send again after a lost answer replays, not repeats.
  const key = useRef(crypto.randomUUID());
  const count = smsSegments(body).segments;
  const failure = send.error
    ? `console.broadcast.error.${KNOWN_ERRORS.includes(send.error.message) ? send.error.message : 'unknown'}`
    : null;
  const quick = [
    t('console.broadcast.quickLate'),
    t('console.broadcast.quickBreak'),
    t('console.broadcast.quickNear'),
  ];
  const submit = () =>
    send.mutate(
      { body: body.trim(), idempotencyKey: key.current },
      {
        onSuccess: (result) => {
          toast.show({
            message: t('console.broadcast.sent', {
              recipients: result.recipients,
              suppressed: result.suppressed,
            }),
            tone: 'success',
          });
          onClose();
        },
        onError: () => setConfirming(false),
      },
    );

  return (
    <Dialog
      open
      onClose={onClose}
      title={
        confirming
          ? t('console.broadcast.confirmTitle', { count: reachable })
          : t('console.broadcast.title', { name: queue.name })
      }
      description={
        confirming ? t('console.broadcast.confirmNote') : t('console.broadcast.description')
      }
      footer={
        confirming ? (
          <>
            <Button
              variant="secondary"
              onClick={() => setConfirming(false)}
              disabled={send.isPending}
            >
              {t('console.broadcast.back')}
            </Button>
            <Button
              loading={send.isPending}
              loadingLabel={t('console.broadcast.sending')}
              onClick={submit}
            >
              {t('console.broadcast.send')}
            </Button>
          </>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose}>
              {t('console.broadcast.cancel')}
            </Button>
            <Button disabled={!body.trim()} onClick={() => setConfirming(true)}>
              {t('console.broadcast.review')}
            </Button>
          </>
        )
      }
    >
      {confirming ? (
        <p className="whitespace-pre-wrap rounded-card bg-surface-raised p-3">{body.trim()}</p>
      ) : (
        <div className="flex flex-col gap-3">
          <div
            role="group"
            aria-label={t('console.broadcast.quick')}
            className="flex flex-wrap gap-2"
          >
            {quick.map((text) => (
              <Button key={text} variant="secondary" onClick={() => setBody(text)}>
                {text}
              </Button>
            ))}
          </div>
          <Textarea
            label={t('console.broadcast.message')}
            hint={t('console.broadcast.hint')}
            value={body}
            maxLength={320}
            onChange={(e) => setBody(e.target.value)}
          />
          <p className="flex gap-2 text-muted">
            <span>{t('console.broadcast.count', { chars: body.length })}</span>
            <Badge>{t('console.broadcast.segments', { count })}</Badge>
          </p>
        </div>
      )}
      <p role="alert" className="font-medium text-danger-strong empty:hidden">
        {failure ? t(failure as 'console.broadcast.error.unknown') : null}
      </p>
    </Dialog>
  );
}
