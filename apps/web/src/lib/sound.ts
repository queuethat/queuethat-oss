import { useCallback, useEffect, useRef, useState } from 'react';

// Browsers (iOS Safari above all) play audio only after a tap on the page, so pages that alert
// by sound ask for one tap and keep that unlocked AudioContext for the page load. Used by the
// guest's call alert (G6, #56) and the staff console's arrival chime (C8, #65).

type AudioCtor = typeof AudioContext;

function audioContextClass(): AudioCtor | null {
  const w = window as typeof window & { webkitAudioContext?: AudioCtor };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

export type AlertSound = ReturnType<typeof useAlertSound>;

/**
 * Sound for this page load. `enable` must run inside a tap: it creates and resumes the
 * AudioContext and plays a short tone, which both unlocks iOS and proves the speaker works.
 * `play(pulses)` does nothing until then. Nothing here can see the iPad's mute switch.
 */
export function useAlertSound() {
  const ctx = useRef<AudioContext | null>(null);
  const [enabled, setEnabled] = useState(false);
  const supported = audioContextClass() !== null;

  const enable = useCallback(() => {
    const Ctor = audioContextClass();
    if (!Ctor) return;
    ctx.current ??= new Ctor();
    void ctx.current.resume();
    chime(ctx.current, 1);
    setEnabled(true);
  }, []);

  const play = useCallback((pulses = 3) => {
    if (!ctx.current) return;
    // A tablet that slept suspends the context; resuming after the first tap is allowed.
    void ctx.current.resume();
    chime(ctx.current, pulses);
  }, []);

  useEffect(() => () => void ctx.current?.close(), []);
  return { supported, enabled, enable, play };
}

/** `pulses` short 880 Hz beeps, synthesized so there is no audio file to load. */
function chime(ctx: AudioContext, pulses: number) {
  const start = ctx.currentTime;
  for (let i = 0; i < pulses; i++) {
    const at = start + i * 0.45;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.4, at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.3);
    osc.connect(gain).connect(ctx.destination);
    osc.start(at);
    osc.stop(at + 0.32);
  }
}
