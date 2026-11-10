import {
  Badge,
  Button,
  ConfirmDestructive,
  EmptyState,
  Input,
  PageHeader,
  Select,
  Spinner,
} from '@qm/ui';
import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from '../../../lib/translation.tsx';
import { useNow } from '../../../lib/now.ts';
import {
  opsError,
  platformBlocksQuery,
  useBlockContact,
  useUnblockContact,
  type BlockKind,
} from './api.ts';

const KINDS: BlockKind[] = ['phone', 'email'];

/** The reason keys the page words, beyond the usual write errors. */
function errorKey(error: Error) {
  return error.message === 'reason_contains_contact' ? error.message : opsError(error);
}

/**
 * `/platform/blocks` (PLT13, #419): blocks a phone or email from every queue on the platform. The
 * database keeps only a keyed hash of each contact, so the list shows kind, reason and expiry and
 * never the contact; to remove a block the operator enters the contact again.
 */
export function BlocksPage() {
  const { t, i18n } = useTranslation('platform');
  const blocks = useQuery(platformBlocksQuery);
  const block = useBlockContact();
  const unblock = useUnblockContact();
  const now = useNow(60_000);
  const [kind, setKind] = useState<BlockKind>('phone');
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const [expires, setExpires] = useState('');
  const [removeKind, setRemoveKind] = useState<BlockKind>('phone');
  const [removeValue, setRemoveValue] = useState('');
  const time = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    block.mutate(
      {
        kind,
        value,
        reason,
        expiresAt: expires ? new Date(expires).toISOString() : null,
      },
      {
        // The contact leaves the page as soon as the server has it.
        onSuccess: () => {
          setValue('');
          setReason('');
          setExpires('');
          block.reset();
        },
      },
    );
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('ops.blocks.title')} />
      <p className="text-muted">{t('ops.blocks.intro')}</p>

      <section aria-labelledby="blocks-list" className="flex flex-col gap-3">
        <h2 id="blocks-list" className="text-xl font-semibold">
          {t('ops.blocks.list')}
        </h2>
        {!blocks.data ? (
          blocks.isError ? (
            <EmptyState title={t('ops.loadFailed')} />
          ) : (
            <Spinner label={t('ops.loading')} />
          )
        ) : blocks.data.length === 0 ? (
          <EmptyState title={t('ops.blocks.none')} />
        ) : (
          <table className="w-full text-left">
            <thead>
              <tr>
                <th scope="col">{t('ops.blocks.kind')}</th>
                <th scope="col">{t('ops.blocks.reason')}</th>
                <th scope="col">{t('ops.blocks.added')}</th>
                <th scope="col">{t('ops.blocks.expires')}</th>
              </tr>
            </thead>
            <tbody>
              {blocks.data.map((b) => {
                const expired = b.expires_at !== null && Date.parse(b.expires_at) <= now;
                return (
                  <tr key={`${b.created_at}-${b.kind}`} data-testid="block">
                    <td>{t(`ops.blocks.kinds.${b.kind as BlockKind}`)}</td>
                    <td>{b.reason}</td>
                    <td>{time.format(new Date(b.created_at))}</td>
                    <td>
                      {b.expires_at === null ? (
                        t('ops.blocks.never')
                      ) : expired ? (
                        <Badge>{t('ops.blocks.expired')}</Badge>
                      ) : (
                        time.format(new Date(b.expires_at))
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <form aria-labelledby="block-form" className="flex flex-col gap-4" onSubmit={submit}>
        <h2 id="block-form" className="text-xl font-semibold">
          {t('ops.blocks.add')}
        </h2>
        <Select
          label={t('ops.blocks.kind')}
          value={kind}
          onChange={(e) => setKind(e.target.value as BlockKind)}
        >
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {t(`ops.blocks.kinds.${k}`)}
            </option>
          ))}
        </Select>
        <Input
          label={t('ops.blocks.value')}
          hint={t(`ops.blocks.valueHint.${kind}`)}
          type={kind === 'email' ? 'email' : 'tel'}
          autoComplete="off"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          required
        />
        <Input
          label={t('ops.blocks.reason')}
          hint={t('ops.blocks.reasonHint')}
          autoComplete="off"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          required
        />
        <Input
          type="datetime-local"
          label={t('ops.blocks.expiresField')}
          hint={t('ops.blocks.expiresHint')}
          value={expires}
          onChange={(e) => setExpires(e.target.value)}
        />
        <p role="alert" className="font-medium text-danger-strong empty:hidden">
          {block.error ? t(`ops.blocks.errors.${errorKey(block.error)}`) : null}
        </p>
        <div>
          <Button type="submit" loading={block.isPending} loadingLabel={t('ops.saving')}>
            {t('ops.blocks.submit')}
          </Button>
        </div>
      </form>

      <section aria-labelledby="unblock-form" className="flex flex-col gap-4">
        <h2 id="unblock-form" className="text-xl font-semibold">
          {t('ops.blocks.remove')}
        </h2>
        <p className="text-muted">{t('ops.blocks.removeHint')}</p>
        <Select
          label={t('ops.blocks.kind')}
          value={removeKind}
          onChange={(e) => setRemoveKind(e.target.value as BlockKind)}
        >
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {t(`ops.blocks.kinds.${k}`)}
            </option>
          ))}
        </Select>
        <Input
          label={t('ops.blocks.removeValue')}
          type={removeKind === 'email' ? 'email' : 'tel'}
          autoComplete="off"
          value={removeValue}
          onChange={(e) => setRemoveValue(e.target.value)}
        />
        <p role="alert" className="font-medium text-danger-strong empty:hidden">
          {unblock.error ? t(`ops.blocks.errors.${errorKey(unblock.error)}`) : null}
        </p>
        <div>
          <ConfirmDestructive
            triggerVariant="secondary"
            triggerLabel={t('ops.blocks.removeTrigger')}
            title={t('ops.blocks.removeTitle')}
            description={t('ops.blocks.removeDescription')}
            confirmLabel={t('ops.blocks.removeConfirm')}
            cancelLabel={t('ops.cancel')}
            disabled={!removeValue.trim()}
            onConfirm={() =>
              unblock.mutateAsync({ kind: removeKind, value: removeValue }).then(
                () => {
                  setRemoveValue('');
                  unblock.reset();
                },
                () => {},
              )
            }
          />
        </div>
      </section>
    </div>
  );
}
