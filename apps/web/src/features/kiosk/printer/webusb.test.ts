import { describe, expect, it, vi } from 'vitest';
import { sendToPrinter, webUsb, type UsbDeviceLike } from './webusb.ts';

function device(over: Partial<UsbDeviceLike> = {}, status = 'ok'): UsbDeviceLike {
  return {
    vendorId: 1,
    productId: 2,
    opened: false,
    configuration: null,
    open: vi.fn(async function (this: UsbDeviceLike) {
      this.opened = true;
    }),
    selectConfiguration: vi.fn(async function (this: UsbDeviceLike) {
      this.configuration = {
        interfaces: [
          {
            interfaceNumber: 0,
            alternate: {
              interfaceClass: 255,
              endpoints: [{ endpointNumber: 5, direction: 'out', type: 'bulk' }],
            },
          },
          {
            interfaceNumber: 1,
            alternate: {
              interfaceClass: 7,
              endpoints: [
                { endpointNumber: 1, direction: 'in', type: 'bulk' },
                { endpointNumber: 2, direction: 'out', type: 'bulk' },
              ],
            },
          },
        ],
      };
    }),
    claimInterface: vi.fn(async () => undefined),
    releaseInterface: vi.fn(async () => undefined),
    transferOut: vi.fn(async () => ({ status })),
    ...over,
  };
}

describe('webUsb', () => {
  it('is null where the browser has no WebUSB (Safari)', () => {
    expect(webUsb({})).toBeNull();
  });
  it('returns the browser object when present', () => {
    const usb = { getDevices: vi.fn(), requestDevice: vi.fn() };
    expect(webUsb({ usb })).toBe(usb);
  });
});

describe('sendToPrinter', () => {
  it('opens, claims the printer-class interface and writes to its bulk OUT endpoint', async () => {
    const d = device();
    const bytes = Uint8Array.of(0x1b, 0x40);
    await sendToPrinter(d, bytes);
    expect(d.claimInterface).toHaveBeenCalledWith(1);
    expect(d.transferOut).toHaveBeenCalledWith(2, bytes);
    expect(d.releaseInterface).toHaveBeenCalledWith(1);
  });

  it('throws when the transfer stalls, so the caller can fall back to the dialog', async () => {
    const d = device({}, 'stall');
    await expect(sendToPrinter(d, Uint8Array.of(1))).rejects.toThrow('usb_stall');
    expect(d.releaseInterface).toHaveBeenCalled();
  });

  it('throws when the device has no bulk OUT endpoint', async () => {
    const d = device({
      opened: true,
      configuration: { interfaces: [] },
    });
    await expect(sendToPrinter(d, Uint8Array.of(1))).rejects.toThrow('no_printer_endpoint');
  });
});
