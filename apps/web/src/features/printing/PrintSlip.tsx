import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { TicketSlip, type Slip } from '../kiosk/print/TicketSlip.tsx';

/**
 * Prints one ticket slip from a staff screen (2B-D3), then calls `onDone`. The slip is mounted in
 * a portal on `<body>`, and while it is there `body.print-slip` hides everything else when
 * printing, so the console around it never prints. `window.print()` opens the browser's dialog;
 * with Chrome's `--kiosk-printing` it prints silently (docs/guides/thermal-printing.md).
 */
export function PrintSlip({ slip, onDone }: { slip: Slip; onDone: () => void }) {
  useEffect(() => {
    document.body.classList.add('print-slip');
    // Let the slip paint first; print() blocks the page until the dialog closes.
    const frame = requestAnimationFrame(() => {
      window.print();
      onDone();
    });
    return () => {
      cancelAnimationFrame(frame);
      document.body.classList.remove('print-slip');
    };
    // The print happens once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return createPortal(<TicketSlip slip={slip} />, document.body);
}
