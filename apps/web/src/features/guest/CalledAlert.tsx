import { BigButton, Card, StatusPill, TicketNumber } from '@qm/ui';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useTranslation } from '../../lib/translation.tsx';
import type { AlertSound } from '../../lib/sound.ts';

// G6 (#56): a call reaches the guest by screen, sound and vibration together (G-5, G-10).
// Browsers (iOS Safari above all) play audio only after a tap on the page, so the page asks
// for one while the guest waits and keeps that unlocked sound for the call.

/**
 * "Tap to turn on sound" while the guest waits, until they tap it. `bare` drops its own card so
 * it can share the status page's one alerts card (#86).
 */
export function SoundGate({ sound, bare = false }: { sound: AlertSound; bare?: boolean }) {
  const { t } = useTranslation('guest');
  if (!sound.supported) return null;
  if (sound.enabled) {
    return (
      <p role="status" className="text-center text-muted">
        {t('status.alert.soundOn')}
      </p>
    );
  }
  const ask = (
    <>
      <p>{t('status.alert.soundHint')}</p>
      <BigButton variant="secondary" onClick={sound.enable}>
        {t('status.alert.enableSound')}
      </BigButton>
    </>
  );
  return bare ? ask : <Card className="flex flex-col gap-3">{ask}</Card>;
}

/**
 * Takes over the screen while the visit is called, with the counter to go to, and rings and
 * vibrates once per call: a recall (a higher `callCount`) alerts again, even after "Got it".
 * Status, counter and call count come from api.get_visit_status; nothing is derived here.
 * `children` (the guest's own actions) sit inside the takeover while it shows and in the page's
 * flow otherwise, so the one-tap answers are never hidden behind "Got it".
 */
export function CalledTakeover({
  called,
  callCount,
  ticket,
  counter,
  sound,
  children,
}: {
  called: boolean;
  callCount: number;
  ticket: string;
  counter: string | null;
  sound: AlertSound;
  children?: ReactNode;
}) {
  const { t } = useTranslation('guest');
  const [dismissed, setDismissed] = useState(0);
  const alerted = useRef(0);
  const dismiss = useRef<HTMLButtonElement>(null);
  const showing = called && dismissed < callCount;

  useEffect(() => {
    if (!called || alerted.current >= callCount) return;
    alerted.current = callCount;
    sound.play();
    navigator.vibrate?.([400, 200, 400, 200, 400]);
  }, [called, callCount, sound]);

  useEffect(() => {
    if (showing) dismiss.current?.focus();
  }, [showing]);

  if (!showing) return <>{children}</>;
  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="called-title"
      aria-describedby="called-counter"
      className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-6 border-8 border-state-called-edge bg-state-called-soft p-6 text-center text-fg motion-safe:animate-fade-in"
      data-testid="called-takeover"
    >
      <StatusPill status="called">{t('status.state.called')}</StatusPill>
      <h2 id="called-title" className="text-4xl font-bold">
        {t('status.alert.title')}
      </h2>
      <TicketNumber ticket={ticket} size="tv" />
      <p id="called-counter" className="text-2xl font-semibold">
        {counter ? t('status.alert.goTo', { counter }) : t('status.alert.goToDesk')}
      </p>
      {children}
      <BigButton
        ref={dismiss}
        variant="secondary"
        className="max-w-sm"
        onClick={() => setDismissed(callCount)}
      >
        {t('status.alert.dismiss')}
      </BigButton>
    </div>
  );
}
