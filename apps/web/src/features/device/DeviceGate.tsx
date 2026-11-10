import { errorCode } from '@qm/domain';
import { Button, Card, Input, Spinner } from '@qm/ui';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useTranslation } from '../../lib/translation.tsx';
import { checkForUpdate } from '../pwa/useAppUpdate.ts';
import { useSession } from '../auth/api.ts';
import {
  PairError,
  useDeviceHeartbeat,
  useForgetDevice,
  usePairDevice,
  useServedVersion,
} from './api.ts';
import { APP_VERSION, shouldReload } from './version.ts';

type DeviceKind = 'display' | 'kiosk';

/**
 * Wraps `/display` and `/kiosk`. Until this browser holds a session for a paired device of
 * `kind`, it shows the pairing screen. Once paired, it keeps the session (supabase-js refreshes
 * it), sends heartbeats, returns to pairing when the device is revoked, and updates itself when
 * a new version is deployed and nobody is using the screen.
 */
export function DeviceGate({ kind, children }: { kind: DeviceKind; children: ReactNode }) {
  const { t } = useTranslation('display');
  const { data: session, isPending } = useSession();
  if (isPending) return <Spinner label={t('pair.loading')} />;
  if (session?.user.app_metadata?.kind !== kind) return <PairScreen />;
  return <PairedDevice>{children}</PairedDevice>;
}

function PairScreen() {
  const { t } = useTranslation('display');
  const pair = usePairDevice();
  const [code, setCode] = useState('');
  const failure = pair.error instanceof PairError ? pair.error.code : pair.error ? 'unknown' : null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    pair.mutate(code.trim());
  };

  return (
    <Card className="mx-auto mt-16 max-w-md">
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <h1 className="text-4xl font-semibold">{t('pair.title')}</h1>
        <p>{t('pair.intro')}</p>
        <Input
          label={t('pair.code')}
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
          maxLength={6}
          value={code}
          onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
          error={
            failure
              ? t(`pair.errors.${failure}`, { defaultValue: t('pair.errors.unknown') })
              : undefined
          }
        />
        <Button
          type="submit"
          disabled={code.length !== 6}
          loading={pair.isPending}
          loadingLabel={t('pair.pairing')}
        >
          {t('pair.submit')}
        </Button>
      </form>
    </Card>
  );
}

const RELOADED_AT_KEY = 'qm.device.reloadedAt';

function PairedDevice({ children }: { children: ReactNode }) {
  const heartbeat = useDeviceHeartbeat();
  const served = useServedVersion();
  const forget = useForgetDevice();
  const lastInput = useLastInput();
  const revoked = heartbeat.error && errorCode(heartbeat.error) === 'not_found';

  useEffect(() => {
    if (revoked && forget.isIdle) forget.mutate();
  }, [revoked, forget]);

  useEffect(() => {
    const now = Date.now();
    const check = {
      running: APP_VERSION,
      served: served.data,
      idleForMs: now - lastInput.current,
      lastReloadAt: readNumber(RELOADED_AT_KEY),
      now,
    };
    if (shouldReload(check)) {
      writeNumber(RELOADED_AT_KEY, now);
      // With a service worker, the new version installs and UpdatePrompt applies it (policy auto).
      void checkForUpdate()
        .catch(() => false)
        .then((found) => found || window.location.reload());
    }
  }, [served.data, served.dataUpdatedAt, lastInput]);

  return children;
}

/** Time of the last touch or key press on this screen (page load counts as one). */
function useLastInput() {
  const last = useRef(0);
  useEffect(() => {
    const touch = () => {
      last.current = Date.now();
    };
    touch();
    window.addEventListener('pointerdown', touch);
    window.addEventListener('keydown', touch);
    return () => {
      window.removeEventListener('pointerdown', touch);
      window.removeEventListener('keydown', touch);
    };
  }, []);
  return last;
}

function readNumber(key: string): number | undefined {
  try {
    const value = Number(window.sessionStorage.getItem(key));
    return value > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function writeNumber(key: string, value: number) {
  try {
    window.sessionStorage.setItem(key, String(value));
  } catch {
    // Storage blocked: the cooldown is lost, which only risks an extra reload.
  }
}
