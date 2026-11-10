import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { guestJoins, openQueue } from './support/console.ts';
import { freshQueue } from './support/queues.ts';

// 2A-ST9 (#142): scan a guest's QR with the camera, or type its code, to act on their visit.

test('AC1: a fake camera showing the guest QR opens the visit with Call available', async ({
  devices,
}) => {
  const { staff, guest } = devices;
  const queue = await freshQueue();
  const { token } = await guestJoins('Scan Sam', queue.id);

  // The guest's own QR, as the guest page draws it.
  await guest.goto(`/v/${token}`);
  await guest.getByText('Show at the counter').click();
  const png = await guest.getByTestId('ticket-qr').screenshot();

  // The staff tablet's camera shows that picture.
  await staff.addInitScript(
    (dataUrl) => {
      const getUserMedia = async () => {
        const img = new Image();
        img.src = dataUrl;
        await img.decode();
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 480;
        const ctx = canvas.getContext('2d')!;
        const draw = () => {
          ctx.fillStyle = '#fff';
          ctx.fillRect(0, 0, 480, 480);
          ctx.drawImage(img, 40, 40, 400, 400);
        };
        draw();
        setInterval(draw, 100);
        return canvas.captureStream(10);
      };
      Object.defineProperty(MediaDevices.prototype, 'getUserMedia', {
        value: getUserMedia,
        configurable: true,
      });
    },
    `data:image/png;base64,${png.toString('base64')}`,
  );
  await openQueue(staff, queue.id);

  await staff.getByRole('button', { name: 'Scan guest QR' }).click();
  const result = staff.getByTestId('scan-result');
  await expect(result).toContainText('Scan Sam', { timeout: 15_000 });
  await expectNoSeriousA11yViolations(staff);
  await result.getByRole('button', { name: /^Call / }).click();
  await expect(result).toContainText('Called');
});

test('AC2: a code that is not at this location says so; the camera stops on close', async ({
  devices,
}) => {
  const { staff } = devices;
  const queue = await freshQueue();
  await staff.addInitScript(() => {
    const getUserMedia = async () => {
      const stream = document.createElement('canvas').captureStream(5);
      (window as unknown as { camera: MediaStream }).camera = stream;
      return stream;
    };
    Object.defineProperty(MediaDevices.prototype, 'getUserMedia', {
      value: getUserMedia,
      configurable: true,
    });
  });
  await openQueue(staff, queue.id);
  await staff.getByRole('button', { name: 'Scan guest QR' }).click();
  await staff.getByLabel('Or type the code').fill('qm:0000000000');
  await staff.getByRole('button', { name: 'Find' }).click();
  await expect(staff.getByText('Not found at this location')).toBeVisible();

  await staff.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  await expect
    .poll(() =>
      staff.evaluate(() =>
        (window as unknown as { camera: MediaStream }).camera
          .getTracks()
          .every((track) => track.readyState === 'ended'),
      ),
    )
    .toBe(true);
});

test('a blocked camera is explained and the typed code still works', async ({ devices }) => {
  const { staff } = devices;
  const queue = await freshQueue();
  await staff.addInitScript(() => {
    Object.defineProperty(MediaDevices.prototype, 'getUserMedia', {
      value: () => Promise.reject(new DOMException('blocked', 'NotAllowedError')),
      configurable: true,
    });
  });
  await openQueue(staff, queue.id);
  await staff.getByRole('button', { name: 'Scan guest QR' }).click();
  await expect(staff.getByText('Camera access is blocked')).toBeVisible();
  await staff.getByLabel('Or type the code').fill('qm:0000000000');
  await staff.getByRole('button', { name: 'Find' }).click();
  await expect(staff.getByText('Not found at this location')).toBeVisible();
});
