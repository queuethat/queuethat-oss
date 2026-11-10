// The slice of WebUSB the kiosk uses. lib.dom has no WebUSB types, and declaring only what is
// called keeps the test double honest.
export interface UsbEndpointLike {
  endpointNumber: number;
  direction: 'in' | 'out';
  type: 'bulk' | 'interrupt' | 'isochronous';
}
export interface UsbDeviceLike {
  productName?: string;
  vendorId: number;
  productId: number;
  opened: boolean;
  configuration: {
    interfaces: {
      interfaceNumber: number;
      alternate: { interfaceClass: number; endpoints: UsbEndpointLike[] };
    }[];
  } | null;
  open(): Promise<void>;
  selectConfiguration(value: number): Promise<void>;
  claimInterface(n: number): Promise<void>;
  releaseInterface(n: number): Promise<void>;
  transferOut(endpoint: number, data: BufferSource): Promise<{ status: string }>;
}
export interface UsbLike {
  getDevices(): Promise<UsbDeviceLike[]>;
  requestDevice(options: { filters: { classCode: number }[] }): Promise<UsbDeviceLike>;
}

const PRINTER_CLASS = 7;
const VENDOR_SPECIFIC_CLASS = 255;

/** The browser's WebUSB entry point, or null (Safari, Firefox, insecure pages): browser print is used. */
export function webUsb(nav: object = navigator): UsbLike | null {
  const usb = (nav as { usb?: UsbLike }).usb;
  return usb && typeof usb.requestDevice === 'function' ? usb : null;
}

/** Shows the browser's device picker. Thermal printers report class 7 (printer) or vendor-specific. */
export function requestPrinter(usb: UsbLike): Promise<UsbDeviceLike> {
  return usb.requestDevice({
    filters: [{ classCode: PRINTER_CLASS }, { classCode: VENDOR_SPECIFIC_CLASS }],
  });
}

/** Printers this origin was already allowed to use, so a restarted kiosk needs no picker. */
export async function grantedPrinters(usb: UsbLike): Promise<UsbDeviceLike[]> {
  try {
    return await usb.getDevices();
  } catch {
    return [];
  }
}

/** Sends bytes over the first bulk OUT endpoint of a printer-capable interface. Throws on failure. */
export async function sendToPrinter(device: UsbDeviceLike, bytes: Uint8Array): Promise<void> {
  if (!device.opened) await device.open();
  if (device.configuration === null) await device.selectConfiguration(1);
  const interfaces = device.configuration?.interfaces ?? [];
  const found = interfaces
    .flatMap((i) =>
      i.alternate.endpoints
        .filter((e) => e.direction === 'out' && e.type === 'bulk')
        .map((e) => ({ i, e })),
    )
    .sort((a, b) => rank(a.i.alternate.interfaceClass) - rank(b.i.alternate.interfaceClass))[0];
  if (!found) throw new Error('no_printer_endpoint');
  await device.claimInterface(found.i.interfaceNumber);
  try {
    const result = await device.transferOut(found.e.endpointNumber, bytes as BufferSource);
    if (result.status !== 'ok') throw new Error(`usb_${result.status}`);
  } finally {
    await device.releaseInterface(found.i.interfaceNumber).catch(() => undefined);
  }
}

function rank(interfaceClass: number): number {
  return interfaceClass === PRINTER_CLASS ? 0 : 1;
}
