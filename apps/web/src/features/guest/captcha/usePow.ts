import { useEffect, useState } from 'react';
import { fetchChallenge } from './publicJoin.ts';

export interface PowState {
  /** The token to send as `captcha`, once solved. */
  token: string | null;
  /** 0..1 while solving. */
  progress: number;
  /** True when the challenge could not be fetched or solved. */
  failed: boolean;
}

const IDLE: PowState = { token: null, progress: 0, failed: false };

/**
 * Solves a proof-of-work challenge in a Web Worker while the guest fills in the form. A new
 * `round` fetches and solves a fresh one (a solved token is single-use). `enabled` false does
 * nothing, so other providers pay nothing.
 */
export function usePow(enabled: boolean, round: number): PowState {
  const [state, setState] = useState<PowState & { round: number }>({ ...IDLE, round });

  useEffect(() => {
    if (!enabled) return;
    let worker: Worker | null = null;
    let cancelled = false;
    const set = (next: PowState) => {
      if (!cancelled) setState({ ...next, round });
    };
    fetchChallenge()
      .then(({ challenge, difficulty }) => {
        if (cancelled) return;
        worker = new Worker(
          new URL('../../../../../../packages/providers/src/captcha/powWorker.ts', import.meta.url),
          { type: 'module' },
        );
        worker.onmessage = (
          event: MessageEvent<{ type: string; fraction?: number; token?: string }>,
        ) => {
          const message = event.data;
          if (message.type === 'progress') set({ ...IDLE, progress: message.fraction ?? 0 });
          else if (message.type === 'done' && message.token) {
            set({ token: message.token, progress: 1, failed: false });
          } else set({ ...IDLE, failed: true });
        };
        worker.onerror = () => set({ ...IDLE, failed: true });
        worker.postMessage({ challenge, difficulty });
      })
      .catch(() => set({ ...IDLE, failed: true }));
    return () => {
      cancelled = true;
      worker?.terminate();
    };
  }, [enabled, round]);

  // A state from an earlier round is stale the moment the round changes.
  return state.round === round ? state : IDLE;
}
