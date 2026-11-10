import { randomUUID } from 'node:crypto';
import { demo } from '../fixtures/demo.ts';
import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { supabaseEnv } from './support/env.ts';

// G-6, G-7 (#125, #126): the status page says where the place is and shows a QR for the counter.

const { url, anonKey } = supabaseEnv();

async function join(name: string): Promise<string> {
  const response = await fetch(`${url}/rest/v1/rpc/join_queue`, {
    method: 'POST',
    headers: {
      apikey: anonKey,
      authorization: `Bearer ${anonKey}`,
      'content-type': 'application/json',
      'content-profile': 'api',
      'accept-profile': 'api',
    },
    body: JSON.stringify({
      p_queue_id: demo.queues.kids,
      p_service_id: null,
      p_name: name,
      p_phone_e164: null,
      p_email: null,
      p_party_size: 1,
      p_locale: 'en',
      p_idempotency_key: randomUUID(),
      p_device_key: randomUUID().replaceAll('-', ''),
    }),
  });
  if (!response.ok) throw new Error(`join_queue: ${response.status} ${await response.text()}`);
  return ((await response.json()) as { token: string }).token;
}

test('the status page links the place and shows a QR that is not the private link', async ({
  devices,
}) => {
  const { guest } = devices;
  const token = await join('Info');
  await guest.goto(`/v/${token}`);

  await guest.getByText('About this place').click();
  await expect(guest.getByRole('link', { name: 'Get directions' })).toHaveAttribute(
    'rel',
    'noopener noreferrer',
  );
  await expect(guest.getByRole('link', { name: /^Call / })).toHaveAttribute('href', /^tel:\+?\d+$/);

  await guest.getByText('Show at the counter').click();
  const qr = guest.getByTestId('ticket-qr');
  await expect(qr).toBeVisible();
  const code = (await guest.getByTestId('ticket-qr-code').textContent()) ?? '';
  expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{10}$/);
  expect(await guest.content()).not.toContain(`qm:${token}`);
  await expectNoSeriousA11yViolations(guest);
});
