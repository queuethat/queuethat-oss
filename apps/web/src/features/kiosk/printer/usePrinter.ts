import { useCallback, useEffect, useState } from 'react';
import {
  grantedPrinters,
  requestPrinter,
  sendToPrinter,
  webUsb,
  type UsbDeviceLike,
} from './webusb.ts';

const KEY = 'qm:kiosk:printer';

function saved(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}
const idOf = (d: UsbDeviceLike) => `${d.vendorId}:${d.productId}`;

export interface Printer {
  /** False where WebUSB does not exist (Safari, iPad): the connect option is hidden. */
  supported: boolean;
  /** The remembered printer's name, or null when none is connected. */
  name: string | null;
  connect(): Promise<void>;
  /** Prints over USB when a printer is connected, else (or if that fails) the browser dialog. */
  print(bytes: Uint8Array): Promise<'usb' | 'browser'>;
}

/**
 * The kiosk's direct printer. The browser remembers the permission, so the chosen device is found
 * again with `getDevices()` after a restart; localStorage only holds which of several to prefer.
 */
export function usePrinter(): Printer {
  const usb = webUsb();
  const [device, setDevice] = useState<UsbDeviceLike | null>(null);

  useEffect(() => {
    if (!usb) return;
    void grantedPrinters(usb).then((all) => {
      setDevice(all.find((d) => idOf(d) === saved()) ?? all[0] ?? null);
    });
  }, [usb]);

  const connect = useCallback(async () => {
    if (!usb) return;
    try {
      const next = await requestPrinter(usb);
      setDevice(next);
      localStorage.setItem(KEY, idOf(next));
    } catch {
      // the picker was dismissed, or storage is unavailable: keep what was connected before
    }
  }, [usb]);

  const print = useCallback(
    async (bytes: Uint8Array) => {
      if (device) {
        try {
          await sendToPrinter(device, bytes);
          return 'usb' as const;
        } catch {
          // unplugged, busy or out of paper: the guest still gets a slip from the dialog
        }
      }
      window.print();
      return 'browser' as const;
    },
    [device],
  );

  return {
    supported: usb !== null,
    name: device ? (device.productName ?? 'USB') : null,
    connect,
    print,
  };
}
