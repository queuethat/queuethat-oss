import { Button, Dialog, Select, useToast } from '@qm/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import { useTranslation } from '../../lib/translation.tsx';
import { useCurrentLocation, useCurrentOrg } from '../auth/current.ts';
import { lockOperator, useSetMyPin, useSwitchCandidates, useSwitchOperator } from './api.ts';
import { startIdleLock, WARN_MS } from './idle.ts';
import { getOperator, subscribeOperator } from './session.ts';

const MAX_PIN = 8;

/** Who is working on this shared tablet, with Switch, Lock and Set my PIN (2A-TM5, #99). */
export function OperatorChip() {
  const { t } = useTranslation('auth');
  const operator = useSyncExternalStore(subscribeOperator, getOperator, () => null);
  const org = useCurrentOrg();
  const { location } = useCurrentLocation();
  const [switching, setSwitching] = useState(false);
  const [settingPin, setSettingPin] = useState(false);
  const queryClient = useQueryClient();

  // A different operator sees different data, so nothing cached under the last one stays.
  const previous = useRef(operator?.userId);
  useEffect(() => {
    if (previous.current === operator?.userId) return;
    previous.current = operator?.userId;
    void queryClient.invalidateQueries();
  }, [operator?.userId, queryClient]);

  if (!org || !location) return null;
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="operator-chip">
      <span className="font-medium">
        {operator
          ? t('operator.chip', { name: operator.displayName ?? t('operator.unnamed') })
          : t('operator.ownAccount')}
      </span>
      <Button variant="secondary" onClick={() => setSwitching(true)}>
        {t('operator.switch')}
      </Button>
      {operator ? (
        <Button variant="secondary" onClick={() => void lockOperator()}>
          {t('operator.lock')}
        </Button>
      ) : (
        // set_my_pin refuses an operator token: a PIN changes only from the person's own login.
        <Button variant="secondary" onClick={() => setSettingPin(true)}>
          {t('operator.setPin')}
        </Button>
      )}
      {switching ? (
        <SwitchDialog orgId={org.id} locationId={location.id} onClose={() => setSwitching(false)} />
      ) : null}
      {settingPin ? <PinDialog orgId={org.id} onClose={() => setSettingPin(false)} /> : null}
      {operator ? <IdleGuard /> : null}
    </div>
  );
}

/** Four-to-eight digit entry on big buttons; the typed digits are shown as dots. */
function Keypad({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  const { t } = useTranslation('auth');
  return (
    <div className="flex flex-col gap-3">
      <p
        className="min-h-12 text-center font-mono text-3xl tracking-widest"
        aria-live="polite"
        data-testid="pin-dots"
      >
        {'•'.repeat(value.length)}
      </p>
      <div className="grid grid-cols-3 gap-2">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((digit) => (
          <Button
            key={digit}
            variant="secondary"
            aria-label={t('operator.digit', { digit })}
            onClick={() => value.length < MAX_PIN && onChange(value + digit)}
          >
            {digit}
          </Button>
        ))}
        <span />
        <Button
          variant="secondary"
          aria-label={t('operator.digit', { digit: '0' })}
          onClick={() => value.length < MAX_PIN && onChange(`${value}0`)}
        >
          0
        </Button>
        <Button variant="secondary" onClick={() => onChange(value.slice(0, -1))}>
          {t('operator.delete')}
        </Button>
      </div>
    </div>
  );
}

function SwitchDialog({
  orgId,
  locationId,
  onClose,
}: {
  orgId: string;
  locationId: string;
  onClose: () => void;
}) {
  const { t } = useTranslation('auth');
  const candidates = useSwitchCandidates(orgId, locationId);
  const mutation = useSwitchOperator(locationId);
  const [userId, setUserId] = useState('');
  const [pin, setPin] = useState('');
  const chosen = userId || candidates.data?.[0]?.userId || '';

  const submit = (event: FormEvent) => {
    event.preventDefault();
    mutation.mutate(
      { userId: chosen, pin },
      {
        onSuccess: (ok) => {
          if (ok) return onClose();
          setPin('');
        },
        onError: () => setPin(''),
      },
    );
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('operator.switchTitle')}
      description={t('operator.switchDescription')}
    >
      {candidates.data && candidates.data.length === 0 ? (
        <p>{t('operator.noCandidates')}</p>
      ) : (
        <form className="flex flex-col gap-4" onSubmit={submit}>
          <Select
            label={t('operator.person')}
            value={chosen}
            onChange={(event) => setUserId(event.target.value)}
          >
            {candidates.data?.map((m) => (
              <option key={m.id} value={m.userId!}>
                {m.displayName ?? m.email ?? t('operator.unnamed')}
              </option>
            ))}
          </Select>
          <Keypad value={pin} onChange={setPin} />
          <p role="alert" className="font-medium text-danger-strong empty:hidden">
            {mutation.data === false
              ? t('operator.wrongPin')
              : mutation.isError
                ? t('operator.failed')
                : null}
          </p>
          <div className="flex justify-end gap-3">
            <Button variant="secondary" onClick={onClose}>
              {t('operator.cancel')}
            </Button>
            <Button
              type="submit"
              loading={mutation.isPending}
              loadingLabel={t('working')}
              disabled={pin.length < 4 || !chosen}
            >
              {t('operator.confirm')}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

function PinDialog({ orgId, onClose }: { orgId: string; onClose: () => void }) {
  const { t } = useTranslation('auth');
  const toast = useToast();
  const mutation = useSetMyPin(orgId);
  const [pin, setPin] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    mutation.mutate(pin, {
      onSuccess: () => {
        toast.show({ message: t('operator.pinSaved'), tone: 'success' });
        onClose();
      },
      onError: () => setPin(''),
    });
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('operator.pinTitle')}
      description={t('operator.pinDescription')}
    >
      <form className="flex flex-col gap-4" onSubmit={submit}>
        <Keypad value={pin} onChange={setPin} />
        <p role="alert" className="font-medium text-danger-strong empty:hidden">
          {mutation.error
            ? mutation.error.message === 'invalid_input'
              ? t('operator.pinInvalid')
              : t('operator.failed')
            : null}
        </p>
        <div className="flex justify-end gap-3">
          <Button variant="secondary" onClick={onClose}>
            {t('operator.cancel')}
          </Button>
          <Button
            type="submit"
            loading={mutation.isPending}
            loadingLabel={t('working')}
            disabled={pin.length < 4}
          >
            {t('operator.pinSave')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Locks the tablet after 10 idle minutes, with a 20 second warning. Mounted only while an operator is in. */
function IdleGuard() {
  const { t } = useTranslation('auth');
  const toast = useToast();
  const [left, setLeft] = useState<number | null>(null);
  const [stayKey, setStayKey] = useState(0);

  useEffect(() => {
    let countdown: ReturnType<typeof setInterval> | undefined;
    const lock = startIdleLock({
      onWarn: () => {
        setLeft(WARN_MS / 1000);
        countdown = setInterval(() => setLeft((s) => (s === null ? s : Math.max(0, s - 1))), 1000);
      },
      onLock: () => {
        clearInterval(countdown);
        setLeft(null);
        toast.show({ message: t('operator.locked') });
        void lockOperator();
      },
    });
    const touch = () => lock.touch();
    const events = ['pointerdown', 'keydown'] as const;
    events.forEach((e) => window.addEventListener(e, touch, { passive: true }));
    return () => {
      lock.stop();
      clearInterval(countdown);
      events.forEach((e) => window.removeEventListener(e, touch));
    };
  }, [stayKey, t, toast]);

  return (
    <Dialog
      open={left !== null}
      onClose={() => setStayKey((k) => k + 1)}
      title={t('operator.idleTitle')}
      description={t('operator.idleBody', { seconds: left ?? 0 })}
      footer={
        <Button
          onClick={() => {
            setLeft(null);
            setStayKey((k) => k + 1);
          }}
        >
          {t('operator.idleStay')}
        </Button>
      }
    />
  );
}
