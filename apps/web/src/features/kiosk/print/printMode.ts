import { useState } from 'react';

/** Whether this kiosk prints a slip after a check-in: never, when the guest taps, or every time. */
export type PrintMode = 'off' | 'ask' | 'always';

export const PRINT_MODES: readonly PrintMode[] = ['off', 'ask', 'always'];

const KEY = 'qm:kiosk:print';

/** The saved mode for this device; off when nothing is saved or storage is unavailable. */
export function readPrintMode(): PrintMode {
  try {
    const saved = localStorage.getItem(KEY);
    return PRINT_MODES.includes(saved as PrintMode) ? (saved as PrintMode) : 'off';
  } catch {
    return 'off';
  }
}

/** The print mode, kept on this device (localStorage) so a restarted tablet keeps its setting. */
export function usePrintMode(): [PrintMode, (mode: PrintMode) => void] {
  const [mode, setMode] = useState(readPrintMode);
  return [
    mode,
    (next) => {
      setMode(next);
      try {
        localStorage.setItem(KEY, next);
      } catch {
        // storage unavailable: the choice lasts until the next reload
      }
    },
  ];
}
