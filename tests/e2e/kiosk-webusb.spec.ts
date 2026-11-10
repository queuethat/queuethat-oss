import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { openKiosk, shop } from './support/kiosk.ts';

// 4-HW1 (#388): a Chromium kiosk with a USB thermal printer prints without the dialog. The USB
// device is a mock that records the bytes written to it; no real printer is involved.

test.use({ staffUser: null });

type Win = { usbWrites: number[][]; prints: number };

async function openWith(
  kiosk: Page,
  opts: { usb: boolean; mode: 'off' | 'ask' | 'always'; granted?: boolean },
) {
  await kiosk.addInitScript((o) => {
    localStorage.setItem('qm:kiosk:print', o.mode);
    const w = window as unknown as Win;
    w.usbWrites = [];
    w.prints = 0;
    window.print = () => void (w.prints += 1);
    if (!o.usb) {
      Object.defineProperty(navigator, 'usb', { value: undefined, configurable: true });
      return;
    }
    let granted = o.granted ?? false;
    const device = {
      vendorId: 1,
      productId: 2,
      productName: 'Mock POS-80',
      opened: false,
      configuration: null as unknown,
      async open() {
        this.opened = true;
      },
      async selectConfiguration() {
        this.configuration = {
          interfaces: [
            {
              interfaceNumber: 0,
              alternate: {
                interfaceClass: 7,
                endpoints: [{ endpointNumber: 1, direction: 'out', type: 'bulk' }],
              },
            },
          ],
        };
      },
      async claimInterface() {},
      async releaseInterface() {},
      async transferOut(_endpoint: number, data: Uint8Array) {
        w.usbWrites.push(Array.from(data));
        return { status: 'ok' };
      },
    };
    Object.defineProperty(navigator, 'usb', {
      configurable: true,
      value: {
        getDevices: async () => (granted ? [device] : []),
        requestDevice: async () => {
          granted = true;
          return device;
        },
      },
    });
  }, opts);
  await openKiosk(kiosk, (await shop()).code);
}

async function checkIn(kiosk: Page) {
  await kiosk.getByRole('button', { name: 'Check in' }).click();
  await kiosk.getByLabel('First name').fill('Robin');
  await kiosk.getByRole('button', { name: 'Get my ticket' }).click();
  await expect(kiosk.getByTestId('kiosk-ticket')).toBeVisible();
}

const state = (kiosk: Page) =>
  kiosk.evaluate(() => {
    const w = window as unknown as Win;
    return { usbWrites: w.usbWrites, prints: w.prints };
  });

test('connect and test print write an ESC/POS ticket to the printer', async ({ devices }) => {
  const { staff: kiosk } = devices;
  await openWith(kiosk, { usb: true, mode: 'off' });
  await kiosk.getByText('Device settings').click();
  await expect(kiosk.getByTestId('kiosk-printer-status')).toContainText('No printer connected');
  await kiosk.getByRole('button', { name: 'Connect printer' }).click();
  await expect(kiosk.getByTestId('kiosk-printer-status')).toContainText('Mock POS-80');
  await kiosk.getByRole('button', { name: 'Test print' }).click();
  await expect.poll(async () => (await state(kiosk)).usbWrites.length).toBe(1);
  const [bytes] = (await state(kiosk)).usbWrites;
  expect(bytes!.slice(0, 2)).toEqual([0x1b, 0x40]); // ESC @
  expect(String.fromCharCode(...bytes!)).toContain('A000');
  expect((await state(kiosk)).prints).toBe(0);
});

test('a remembered printer prints a join without the dialog', async ({ devices }) => {
  const { staff: kiosk } = devices;
  await openWith(kiosk, { usb: true, mode: 'always', granted: true });
  await checkIn(kiosk);
  await expect.poll(async () => (await state(kiosk)).usbWrites.length).toBe(1);
  const [bytes] = (await state(kiosk)).usbWrites;
  expect(String.fromCharCode(...bytes!)).toMatch(/K\d{3}/);
  expect(String.fromCharCode(...bytes!)).toContain('Front desk');
  expect((await state(kiosk)).prints).toBe(0);
});

test('AC2: without WebUSB (Safari) the connect option is hidden and the dialog is used', async ({
  devices,
}) => {
  const { staff: kiosk } = devices;
  await openWith(kiosk, { usb: false, mode: 'always' });
  await kiosk.getByText('Device settings').click();
  await expect(kiosk.getByRole('button', { name: 'Connect printer' })).toHaveCount(0);
  await kiosk.getByText('Device settings').click();
  await checkIn(kiosk);
  await expect.poll(async () => (await state(kiosk)).prints).toBe(1);
  expect((await state(kiosk)).usbWrites).toHaveLength(0);
});
