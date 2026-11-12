import { Button, Input } from '@qm/ui';
import { useState } from 'react';
import { useTranslation } from '../../../lib/translation.tsx';
import {
  useConfirmMemberPhone,
  useMemberPhone,
  useSendTestSms,
  useStartMemberPhone,
} from './api.ts';

const KNOWN = [
  'rate_limited',
  'invalid_input',
  'code_expired',
  'not_found',
  'phone_not_verified',
  'permission_denied',
];
const known = (error: unknown) =>
  error instanceof Error && KNOWN.includes(error.message) ? error.message : 'unknown';

/**
 * S2b (#1389): "Send me a test". The member confirms their own phone with a texted code once,
 * then texts themselves the saved SMS for `trigger`. Also used by the SMS setup step (T1).
 */
export function TestText({ orgId, trigger }: { orgId: string; trigger: string }) {
  const { t } = useTranslation('admin-templates');
  const phone = useMemberPhone(orgId);
  const start = useStartMemberPhone(orgId);
  const confirm = useConfirmMemberPhone(orgId);
  const send = useSendTestSms(orgId);
  const [number, setNumber] = useState('');
  const [code, setCode] = useState('');
  const [changing, setChanging] = useState(false);
  if (phone.isPending) return null;
  const saved = phone.data;
  const error = start.error ?? confirm.error ?? send.error;
  const message = error
    ? t(`test.error.${known(error)}` as 'test.error.unknown')
    : confirm.data === false
      ? t('test.wrongCode')
      : send.isSuccess
        ? t('test.sent', { phone: saved?.phone ?? '' })
        : null;

  return (
    <section aria-label={t('test.title')} className="flex flex-col gap-2">
      <h3 className="font-medium">{t('test.title')}</h3>
      {saved?.verified && !changing ? (
        <>
          <p className="text-muted">{t('test.ready', { phone: saved.phone })}</p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              loading={send.isPending}
              loadingLabel={t('test.sending')}
              onClick={() => send.mutate(trigger)}
            >
              {t('test.send')}
            </Button>
            <Button variant="secondary" onClick={() => setChanging(true)}>
              {t('test.change')}
            </Button>
          </div>
        </>
      ) : saved && !saved.verified && !changing && start.isSuccess ? (
        <div className="flex flex-wrap items-end gap-2">
          <Input
            label={t('test.code')}
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          <Button
            variant="secondary"
            loading={confirm.isPending}
            loadingLabel={t('test.confirming')}
            disabled={!code.trim()}
            onClick={() => confirm.mutate(code)}
          >
            {t('test.confirm')}
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-end gap-2">
          <Input
            label={t('test.phone')}
            hint={t('test.phoneHint')}
            type="tel"
            autoComplete="tel"
            value={number}
            onChange={(e) => setNumber(e.target.value)}
          />
          <Button
            variant="secondary"
            loading={start.isPending}
            loadingLabel={t('test.sendingCode')}
            disabled={!number.trim()}
            onClick={() =>
              start.mutate(number, {
                onSuccess: () => {
                  setChanging(false);
                  setCode('');
                  confirm.reset();
                },
              })
            }
          >
            {t('test.sendCode')}
          </Button>
        </div>
      )}
      <p role="status" className="empty:hidden">
        {message}
      </p>
    </section>
  );
}
