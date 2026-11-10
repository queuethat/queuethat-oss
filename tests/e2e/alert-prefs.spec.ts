import { randomUUID } from 'node:crypto';
import { demo } from '../fixtures/demo.ts';
import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { supabaseEnv } from './support/env.ts';

// 2P-NTF2 (#174): a guest chooses which alerts they get on the status page, and it sticks.

const { url, anonKey } = supabaseEnv();

async function rpc<T>(fn: string, args: object): Promise<T> {
  const response = await fetch(`${url}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: anonKey,
      authorization: `Bearer ${anonKey}`,
      'content-type': 'application/json',
      'content-profile': 'api',
      'accept-profile': 'api',
    },
    body: JSON.stringify(args),
  });
  if (!response.ok) throw new Error(`${fn}: ${response.status} ${await response.text()}`);
  return (await response.json()) as T;
}

const join = (name: string) =>
  rpc<{ token: string }>('join_queue', {
    p_queue_id: demo.queues.kids,
    p_service_id: null,
    p_name: name,
    p_phone_e164: null,
    p_email: null,
    p_party_size: 1,
    p_locale: 'en',
    p_idempotency_key: randomUUID(),
    p_device_key: randomUUID().replaceAll('-', ''),
  });

test('unticking an alert survives a reload, and each toggle is named (AC1, AC2)', async ({
  devices,
}) => {
  const { guest } = devices;
  const { token } = await join('Alerts');
  await guest.goto(`/v/${token}`);

  await guest.getByRole('button', { name: 'Choose your alerts' }).click();
  const almostUp = guest.getByRole('checkbox', { name: "I'm almost up" });
  await expect(almostUp).toBeChecked();
  await expect(guest.getByRole('checkbox', { name: "It's my turn" })).toBeChecked();
  await expectNoSeriousA11yViolations(guest);

  const saved = guest.waitForResponse((r) => r.url().includes('guest_set_alert_prefs') && r.ok());
  await almostUp.uncheck();
  await saved;

  await guest.reload();
  await guest.getByRole('button', { name: 'Choose your alerts' }).click();
  await expect(guest.getByRole('checkbox', { name: "I'm almost up" })).not.toBeChecked();
  await expect(guest.getByRole('checkbox', { name: "It's my turn" })).toBeChecked();
});
